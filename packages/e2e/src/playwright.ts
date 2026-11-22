import {
  expect as playwrightExpect,
  test as playwrightBaseTest,
  type BrowserContext,
  type Page,
  type PlaywrightTestArgs,
  type PlaywrightTestOptions,
  type PlaywrightWorkerArgs,
  type PlaywrightWorkerOptions,
  type Route,
  type TestInfo,
  type TestType,
} from "@playwright/test";
import { buildSinkFromResolved, createTraceScope } from "./fixtures.js";
import { splitSoftprobeWebOptions } from "./internal/config.js";
import {
  BrowserAttemptLedger,
  buildApiRoutePatterns,
} from "./internal/correlator.js";
import type { TraceSink } from "./internal/sink-shared.js";
import type {
  SoftprobeSinkConfig,
  SoftprobeStoreMode,
  TraceScope,
} from "./types.js";

export interface SoftprobePlaywrightOptions {
  readonly sink?: SoftprobeSinkConfig;
  readonly endpoint?: string;
  readonly token?: string;
  readonly workspaceId?: string;
  readonly tenantId?: string;
  readonly appId?: string;
  readonly store?: SoftprobeStoreMode;
  readonly explorerUrl?: string;
  readonly apiOrigins?: readonly (string | RegExp)[];
  readonly baseUrl?: string;
  readonly traceTimeoutMs?: number;
  readonly pollTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly settleMs?: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface PlaywrightTraceScopeHandle {
  readonly trace: TraceScope;
  dispose(): Promise<void>;
}

function resolvePlaywrightContext(target: BrowserContext | Page): BrowserContext {
  if ("pages" in target) {
    return target;
  }
  return target.context();
}

export async function createPlaywrightTraceScope(
  target: BrowserContext | Page,
  options: SoftprobePlaywrightOptions = {},
): Promise<PlaywrightTraceScopeHandle> {
  const context = resolvePlaywrightContext(target);
  const { env, baseUrl, ...softprobeOpts } = options;
  const { metadata } = splitSoftprobeWebOptions(softprobeOpts);
  const ledger = new BrowserAttemptLedger();
  const patterns = buildApiRoutePatterns(baseUrl, metadata.apiOrigins);

  const routeHandler = async (route: Route): Promise<void> => {
    const request = route.request();
    const headers = request.headers();
    const outcome = ledger.recordRequest({
      method: request.method(),
      url: request.url(),
      headers,
    });
    if (outcome.existingHeaderPreserved || outcome.mintedTraceparent === undefined) {
      await route.continue();
      return;
    }
    await route.continue({
      headers: {
        ...headers,
        traceparent: outcome.mintedTraceparent,
      },
    });
  };

  for (const pattern of patterns) {
    await context.route(pattern, routeHandler);
  }

  let cachedSink: TraceSink | undefined;
  const resolveSink = (): TraceSink => {
    cachedSink ??= buildSinkFromResolved(metadata.rawOptions, env ?? process.env);
    return cachedSink;
  };

  const abortController = new AbortController();
  const trace = createTraceScope({
    ledger,
    ledgerView: ledger.rootView,
    resolveSink,
    pollingDefaults: metadata.polling,
    signal: abortController.signal,
  });

  return {
    trace,
    async dispose(): Promise<void> {
      abortController.abort();
      for (const pattern of patterns) {
        await context.unroute(pattern, routeHandler).catch(() => undefined);
      }
    },
  };
}

export interface SoftprobePlaywrightFixtures {
  readonly softprobe: SoftprobePlaywrightOptions;
  readonly softprobeTrace: TraceScope;
}

export type SoftprobePlaywrightTestArgs = Omit<
  PlaywrightTestArgs &
    PlaywrightTestOptions &
    PlaywrightWorkerArgs &
    PlaywrightWorkerOptions,
  "trace"
> & {
  readonly trace: TraceScope;
  readonly softprobeTrace: TraceScope;
  readonly softprobe: SoftprobePlaywrightOptions;
};

type RawExtendedPlaywrightTest = TestType<
  PlaywrightTestArgs & PlaywrightTestOptions & SoftprobePlaywrightFixtures,
  PlaywrightWorkerArgs & PlaywrightWorkerOptions
>;

type SoftprobePlaywrightCall = {
  (
    title: string,
    body: (args: SoftprobePlaywrightTestArgs, testInfo: TestInfo) => Promise<void> | void,
  ): void;
  (
    title: string,
    details: { readonly tag?: string | readonly string[]; readonly annotation?: unknown },
    body: (args: SoftprobePlaywrightTestArgs, testInfo: TestInfo) => Promise<void> | void,
  ): void;
};

export type SoftprobePlaywrightTest = Omit<
  RawExtendedPlaywrightTest,
  "only" | "skip" | "fixme" | "fail" | "beforeEach" | "afterEach"
> &
  SoftprobePlaywrightCall & {
    only: SoftprobePlaywrightCall;
    skip: SoftprobePlaywrightCall & {
      (condition?: boolean, description?: string): void;
    };
    fixme: SoftprobePlaywrightCall & {
      (condition?: boolean, description?: string): void;
    };
    fail: SoftprobePlaywrightCall & {
      (condition?: boolean, description?: string): void;
    };
    beforeEach(
      body: (args: SoftprobePlaywrightTestArgs, testInfo: TestInfo) => Promise<void> | void,
    ): void;
    afterEach(
      body: (args: SoftprobePlaywrightTestArgs, testInfo: TestInfo) => Promise<void> | void,
    ): void;
  };

function scanBalancedJsSlice(
  source: string,
  openIndex: number,
  openChar: "(" | "{",
  closeChar: ")" | "}",
): { readonly inner: string; readonly closeIndex: number } | null {
  let depth = 0;
  let i = openIndex;
  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      const nl = source.indexOf("\n", i + 2);
      if (nl === -1) return null;
      i = nl + 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const endComment = source.indexOf("*/", i + 2);
      if (endComment === -1) return null;
      i = endComment + 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      i += 1;
      while (i < source.length) {
        const qch = source[i]!;
        if (qch === "\\") {
          i += 2;
          continue;
        }
        if (qch === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === openChar) {
      depth += 1;
    } else if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) {
        return {
          inner: source.slice(openIndex + 1, i),
          closeIndex: i,
        };
      }
    }
    i += 1;
  }
  return null;
}

function findOpeningParamParen(source: string): number {
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      const nl = source.indexOf("\n", i + 2);
      if (nl === -1) return -1;
      i = nl + 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const endComment = source.indexOf("*/", i + 2);
      if (endComment === -1) return -1;
      i = endComment + 2;
      continue;
    }
    if (ch === "(") return i;
    if (ch === "=" && next === ">") return -1;
    i += 1;
  }
  return -1;
}

function splitTopLevelCommas(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    const next = input[i + 1];
    if (ch === "/" && next === "/") {
      const nl = input.indexOf("\n", i + 2);
      i = nl === -1 ? input.length : nl + 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const endComment = input.indexOf("*/", i + 2);
      i = endComment === -1 ? input.length : endComment + 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      i += 1;
      while (i < input.length) {
        const qch = input[i]!;
        if (qch === "\\") {
          i += 2;
          continue;
        }
        if (qch === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") depth += 1;
    else if (ch === "}" || ch === "]" || ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) {
      parts.push(input.slice(start, i).trim());
      start = i + 1;
    }
    i += 1;
  }
  const tail = input.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

function stripLeadingCommentsAndWhitespace(input: string): string {
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    const next = input[i + 1];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      const nl = input.indexOf("\n", i + 2);
      if (nl === -1) return "";
      i = nl + 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const endComment = input.indexOf("*/", i + 2);
      if (endComment === -1) return "";
      i = endComment + 2;
      continue;
    }
    break;
  }
  return input.slice(i);
}

function stripCommentsPreservingStrings(input: string): string {
  let out = "";
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    const next = input[i + 1];
    if (ch === "/" && next === "/") {
      const nl = input.indexOf("\n", i + 2);
      if (nl === -1) break;
      out += "\n";
      i = nl + 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const endComment = input.indexOf("*/", i + 2);
      if (endComment === -1) break;
      out += " ";
      i = endComment + 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < input.length) {
        const qch = input[i]!;
        out += qch;
        if (qch === "\\") {
          if (i + 1 < input.length) {
            out += input[i + 1]!;
          }
          i += 2;
          continue;
        }
        i += 1;
        if (qch === quote) break;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function extractTopLevelBindingPropertyName(entry: string): string {
  const cleaned = stripCommentsPreservingStrings(entry).trim();
  let i = 0;
  let depth = 0;
  while (i < cleaned.length) {
    const ch = cleaned[i]!;
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      i += 1;
      while (i < cleaned.length) {
        if (cleaned[i] === "\\") {
          i += 2;
          continue;
        }
        if (cleaned[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === "(" || ch === "{" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "}" || ch === "]") depth = Math.max(0, depth - 1);
    else if ((ch === ":" || ch === "=") && depth === 0) {
      return cleaned.slice(0, i).trim();
    }
    i += 1;
  }
  return cleaned.trim();
}

function extractFixtureParamNames(fn: (...args: never[]) => unknown): string[] | null {
  const source = fn.toString();
  const openParen = findOpeningParamParen(source);
  if (openParen === -1) return null;
  const paramList = scanBalancedJsSlice(source, openParen, "(", ")");
  if (!paramList) return null;
  const trimmed = stripLeadingCommentsAndWhitespace(paramList.inner).trim();
  if (!trimmed) return [];
  const [firstParam] = splitTopLevelCommas(trimmed);
  if (!firstParam) return null;
  const normalizedFirst = stripLeadingCommentsAndWhitespace(firstParam);
  if (!normalizedFirst.startsWith("{")) {
    return null;
  }
  const destructured = scanBalancedJsSlice(normalizedFirst, 0, "{", "}");
  if (!destructured) return null;
  return splitTopLevelCommas(destructured.inner)
    .map(extractTopLevelBindingPropertyName)
    .filter((name) => name.length > 0 && !name.startsWith("..."));
}

function adaptTraceFixtureCallback<F extends (...args: never[]) => unknown>(fn: F): F {
  if (typeof fn !== "function") return fn;
  const names = extractFixtureParamNames(fn);
  if (!names || !names.includes("trace")) {
    return fn;
  }
  const rewrittenNames = [...new Set(names.map((n) => (n === "trace" ? "softprobeTrace" : n)))];
  const wrapped = async (fixtures: Record<string, unknown>, testInfo: TestInfo) => {
    const callback = fn as unknown as (
      injected: Record<string, unknown>,
      info: TestInfo,
    ) => unknown;
    return callback(
      {
        ...fixtures,
        trace: fixtures["softprobeTrace"],
      },
      testInfo,
    );
  };
  Object.defineProperty(wrapped, "toString", {
    value: () => `async ({ ${rewrittenNames.join(", ")} }, testInfo) => {}`,
    configurable: true,
  });
  return wrapped as unknown as F;
}

function wrapCallableWithAdaptedCallback<T extends (...args: never[]) => unknown>(target: T): T {
  const proxy = new Proxy(target, {
    apply(fn, thisArg, argArray: unknown[]) {
      const adaptedArgs = argArray.map((arg) =>
        typeof arg === "function"
          ? adaptTraceFixtureCallback(arg as (...args: never[]) => unknown)
          : arg,
      );
      return Reflect.apply(fn, thisArg, adaptedArgs);
    },
    get(fn, prop, receiver) {
      const val: unknown = Reflect.get(fn, prop, receiver);
      if (
        typeof val === "function" &&
        (prop === "only" ||
          prop === "skip" ||
          prop === "fixme" ||
          prop === "fail" ||
          prop === "beforeEach" ||
          prop === "afterEach")
      ) {
        return wrapCallableWithAdaptedCallback(
          (val as (...args: never[]) => unknown).bind(fn),
        );
      }
      return val;
    },
  });
  return proxy;
}

export function extendPlaywrightTest(
  base: TestType<
    PlaywrightTestArgs & PlaywrightTestOptions,
    PlaywrightWorkerArgs & PlaywrightWorkerOptions
  > = playwrightBaseTest,
  defaultOptions: SoftprobePlaywrightOptions = {},
): SoftprobePlaywrightTest {
  // Playwright reserves the worker-scoped `trace` option for `use.trace`, so register `softprobeTrace` and adapt `{ trace }` callbacks via Proxy.
  const extended = base.extend<SoftprobePlaywrightFixtures>({
    softprobe: [defaultOptions, { option: true }],
    softprobeTrace: [
      async ({ context, baseURL, softprobe }, use) => {
        const effectiveBaseUrl =
          softprobe.baseUrl ?? defaultOptions.baseUrl ?? baseURL;
        const merged: SoftprobePlaywrightOptions = {
          ...defaultOptions,
          ...softprobe,
          ...(effectiveBaseUrl ? { baseUrl: effectiveBaseUrl } : {}),
        };
        const handle = await createPlaywrightTraceScope(context, merged);
        try {
          await use(handle.trace);
        } finally {
          await handle.dispose();
        }
      },
      { scope: "test", auto: true },
    ],
  });

  return wrapCallableWithAdaptedCallback(extended) as unknown as SoftprobePlaywrightTest;
}

export const test: SoftprobePlaywrightTest = extendPlaywrightTest(playwrightBaseTest);
export const expect = playwrightExpect;
