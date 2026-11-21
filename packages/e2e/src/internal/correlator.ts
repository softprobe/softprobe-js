import { randomBytes } from "node:crypto";
import type { WebRoute } from "@e2e-dev/web";
import {
  isSpanId,
  isTraceId,
  type BrowserTriggerFilter,
  type SpanId,
  type TraceId,
} from "../types.js";

const W3C_TRACEPARENT_PATTERN = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const PARAM_SEGMENT_PATTERN = /^:[A-Za-z_][A-Za-z0-9_]*$/;

export interface ParsedW3cTraceparent {
  readonly version: string;
  readonly traceId: TraceId;
  readonly spanId: SpanId;
  readonly flags: string;
}

export function parseW3cTraceparent(raw: string | undefined): ParsedW3cTraceparent | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  const match = W3C_TRACEPARENT_PATTERN.exec(trimmed);
  if (!match) return null;
  const version = match[1];
  const traceIdCandidate = match[2];
  const spanIdCandidate = match[3];
  const flags = match[4];
  if (
    version === undefined ||
    version === "ff" ||
    flags === undefined ||
    !isTraceId(traceIdCandidate) ||
    !isSpanId(spanIdCandidate)
  ) {
    return null;
  }
  return {
    version,
    traceId: traceIdCandidate,
    spanId: spanIdCandidate,
    flags,
  };
}

export function mintTraceId(): TraceId {
  for (;;) {
    const hex = randomBytes(16).toString("hex");
    if (isTraceId(hex)) return hex;
  }
}

export function mintSpanId(): SpanId {
  for (;;) {
    const hex = randomBytes(8).toString("hex");
    if (isSpanId(hex)) return hex;
  }
}

export function mintW3cTraceparent(): {
  readonly traceId: TraceId;
  readonly spanId: SpanId;
  readonly header: string;
} {
  const traceId = mintTraceId();
  const spanId = mintSpanId();
  return {
    traceId,
    spanId,
    header: `00-${traceId}-${spanId}-01`,
  };
}

export interface RecordedBrowserTrigger {
  readonly traceId: TraceId;
  readonly spanId: SpanId;
  readonly headerSource: "preserved" | "minted";
  readonly method: string;
  readonly url: string;
  readonly origin: string;
  readonly pathname: string;
  readonly startedAt: number;
}

function escapeRegexLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compileSegmentPattern(segment: string): string {
  if (segment === "**") return ".*";
  if (PARAM_SEGMENT_PATTERN.test(segment)) return "[^/]+";
  let out = "";
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    if (ch === undefined) continue;
    if (ch === "*") {
      out += "[^/]*";
    } else {
      out += escapeRegexLiteral(ch);
    }
  }
  return out;
}

export function compileTriggerPathMatcher(
  pattern: string | RegExp,
): (pathname: string) => boolean {
  if (pattern instanceof RegExp) {
    return (pathname) => pattern.test(pathname);
  }
  const withoutQuery = (pattern.split("?")[0] ?? "/").trim();
  const normalized =
    withoutQuery === "" || withoutQuery === "/"
      ? "/"
      : `/${withoutQuery.replace(/^\/+|\/+$/g, "")}`;

  if (normalized === "/") {
    return (pathname) => pathname === "/";
  }

  const segments = normalized.slice(1).split("/");
  const compiledSegments = segments.map(compileSegmentPattern).join("\\/");
  const regex = new RegExp(`^\\/${compiledSegments}\\/?$`);
  return (pathname) => regex.test(pathname);
}

export function matchesTriggerFilter(
  entry: RecordedBrowserTrigger,
  filter: BrowserTriggerFilter | undefined,
): boolean {
  if (filter === undefined) return true;
  if (
    filter.method !== undefined &&
    entry.method.toUpperCase() !== filter.method.trim().toUpperCase()
  ) {
    return false;
  }
  if (filter.origin !== undefined) {
    const normalizedExpected = filter.origin.trim().replace(/\/+$/, "").toLowerCase();
    if (entry.origin.toLowerCase() !== normalizedExpected) {
      return false;
    }
  }
  const pathMatches = compileTriggerPathMatcher(filter.path);
  return pathMatches(entry.pathname);
}

export function buildApiRoutePatterns(
  baseUrl: string | undefined,
  apiOrigins: readonly (string | RegExp)[] | undefined,
): readonly (string | RegExp)[] {
  const patterns: Array<string | RegExp> = [];

  let appOrigin: string | undefined;
  let appBaseClean: string | undefined;
  if (baseUrl !== undefined && baseUrl.trim() !== "") {
    try {
      const parsed = new URL(baseUrl);
      appOrigin = parsed.origin;
      appBaseClean = baseUrl.replace(/\/+$/, "");
      patterns.push(
        new RegExp(`^${escapeRegexLiteral(appBaseClean)}\\/api(?:\\/|$|\\?)`),
      );
      if (appBaseClean !== appOrigin) {
        patterns.push(
          new RegExp(`^${escapeRegexLiteral(appOrigin)}\\/api(?:\\/|$|\\?)`),
        );
      }
    } catch {
      patterns.push("**/api/**");
    }
  } else if (!apiOrigins || apiOrigins.length === 0) {
    patterns.push("**/api/**");
  }

  for (const item of apiOrigins ?? []) {
    if (item instanceof RegExp) {
      patterns.push(item);
      continue;
    }
    const raw = item.trim();
    if (!raw) continue;

    if (raw.includes("*") || raw.includes("?")) {
      if (raw.startsWith("/") && appOrigin !== undefined) {
        patterns.push(`${appOrigin}${raw}`);
      } else {
        patterns.push(raw);
      }
      continue;
    }

    if (raw.startsWith("/")) {
      if (appOrigin !== undefined) {
        const cleanRel = raw.replace(/\/+$/, "") || "/";
        const baseTarget =
          cleanRel === "/" ? appOrigin : `${appOrigin}${cleanRel}`;
        patterns.push(
          new RegExp(`^${escapeRegexLiteral(baseTarget)}(?:\\/|$|\\?)`),
        );
      } else {
        patterns.push(`**${raw}**`);
      }
      continue;
    }

    try {
      const parsed = new URL(raw);
      const cleanRaw = raw.replace(/\/+$/, "");
      if (cleanRaw === parsed.origin) {
        patterns.push(
          new RegExp(`^${escapeRegexLiteral(parsed.origin)}(?:\\/|$|\\?)`),
        );
      } else {
        patterns.push(
          new RegExp(`^${escapeRegexLiteral(cleanRaw)}(?:\\/|$|\\?)`),
        );
      }
    } catch {
      patterns.push(raw);
    }
  }

  return patterns;
}

function readHeaderCaseInsensitive(
  headers: Readonly<Record<string, string>>,
  targetName: string,
): string | undefined {
  const lower = targetName.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) {
      return value;
    }
  }
  return undefined;
}

export type TriggerLedgerView = () => readonly RecordedBrowserTrigger[];

export class BrowserAttemptLedger {
  readonly #entries: RecordedBrowserTrigger[] = [];

  readonly rootView: TriggerLedgerView = () => this.#entries;

  recordRequest(input: {
    readonly method: string;
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly nowMs?: number;
  }): {
    readonly existingHeaderPreserved: boolean;
    readonly mintedTraceparent?: string;
    readonly recorded?: RecordedBrowserTrigger;
  } {
    const method = input.method.toUpperCase();
    if (method === "OPTIONS") {
      return { existingHeaderPreserved: true };
    }

    let origin = "";
    let pathname = "/";
    try {
      const parsedUrl = new URL(input.url);
      origin = parsedUrl.origin;
      pathname = parsedUrl.pathname || "/";
    } catch {
      pathname = input.url.split("?")[0] ?? "/";
    }

    const existingHeader = readHeaderCaseInsensitive(input.headers, "traceparent");
    const parsedExisting = parseW3cTraceparent(existingHeader);
    const startedAt = input.nowMs ?? Date.now();

    if (parsedExisting !== null) {
      const entry: RecordedBrowserTrigger = {
        traceId: parsedExisting.traceId,
        spanId: parsedExisting.spanId,
        headerSource: "preserved",
        method,
        url: input.url,
        origin,
        pathname,
        startedAt,
      };
      this.#entries.push(entry);
      return { existingHeaderPreserved: true, recorded: entry };
    }

    const minted = mintW3cTraceparent();
    const entry: RecordedBrowserTrigger = {
      traceId: minted.traceId,
      spanId: minted.spanId,
      headerSource: "minted",
      method,
      url: input.url,
      origin,
      pathname,
      startedAt,
    };
    this.#entries.push(entry);
    return {
      existingHeaderPreserved: false,
      mintedTraceparent: minted.header,
      recorded: entry,
    };
  }

  async handleRoute(route: WebRoute): Promise<void> {
    const outcome = this.recordRequest({
      method: route.request.method,
      url: route.request.url,
      headers: route.request.headers,
    });
    if (outcome.existingHeaderPreserved || outcome.mintedTraceparent === undefined) {
      await route.continue();
      return;
    }
    await route.continue({
      headers: {
        ...route.request.headers,
        traceparent: outcome.mintedTraceparent,
      },
    });
  }

  async captureWindow(fn: () => Promise<void>): Promise<TriggerLedgerView> {
    const startIndex = this.#entries.length;
    await fn();
    const endIndex = this.#entries.length;
    const snapshot = this.#entries.slice(startIndex, endIndex);
    return () => snapshot;
  }
}

export function selectLatestMatchingTrigger(
  entries: readonly RecordedBrowserTrigger[],
  filter: BrowserTriggerFilter | undefined,
): RecordedBrowserTrigger | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const candidate = entries[i];
    if (candidate !== undefined && matchesTriggerFilter(candidate, filter)) {
      return candidate;
    }
  }
  return undefined;
}
