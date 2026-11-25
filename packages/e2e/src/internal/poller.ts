import {
  TraceAssertionError,
  TraceInstrumentationError,
  type ClientTriggerFilter,
  type ExpectNoOutboundHttpQuery,
  type OutboundHttpCall,
  type OutboundHttpQuery,
  type StatusMatcher,
  type TraceId,
} from "../types.js";
import type { SoftprobePollingDefaults } from "./config.js";
import { selectLatestMatchingTrigger } from "./correlator.js";
import { SinkHttpError, type TracePollSnapshot, type TraceSink } from "./sink-shared.js";
import type { RecordedClientTrigger, TriggerSource } from "./trigger-source.js";

export interface VerifiedTraceEvent {
  readonly traceId: TraceId;
  readonly sinkKind: "blackbox" | "arex";
  readonly sinkUrl: string;
  readonly mode: "outboundHttp" | "expectNoOutboundHttp";
  readonly trigger: RecordedClientTrigger;
  readonly matchedCall?: OutboundHttpCall;
  readonly explorerTraceUrl?: string;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("Polling aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Polling aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function matchesTextOrRegex(actual: string, expected: string | RegExp): boolean {
  if (expected instanceof RegExp) {
    return expected.test(actual);
  }
  return actual === expected || actual.includes(expected);
}

function matchesUrlCriterion(actualUrl: string, expected: string | RegExp): boolean {
  if (expected instanceof RegExp) {
    return expected.test(actualUrl);
  }
  if (actualUrl === expected) return true;
  try {
    const parsed = new URL(actualUrl);
    if (expected.startsWith("/")) {
      return parsed.pathname === expected || `${parsed.pathname}${parsed.search}` === expected;
    }
  } catch {}
  return false;
}

function matchesStatusCriterion(actualStatus: number, matcher: StatusMatcher | undefined): boolean {
  if (matcher === undefined) return true;
  if (typeof matcher === "number") {
    return actualStatus === matcher;
  }
  const [min, max] = matcher;
  return actualStatus >= min && actualStatus <= max;
}

export function matchesOutboundCall(
  call: OutboundHttpCall,
  criteria: {
    readonly method?: string;
    readonly url?: string | RegExp;
    readonly status?: StatusMatcher;
    readonly serviceName?: string | RegExp;
  },
): boolean {
  if (
    criteria.method !== undefined &&
    call.method.toUpperCase() !== criteria.method.trim().toUpperCase()
  ) {
    return false;
  }
  if (criteria.url !== undefined && !matchesUrlCriterion(call.url, criteria.url)) {
    return false;
  }
  if (!matchesStatusCriterion(call.status, criteria.status)) {
    return false;
  }
  if (
    criteria.serviceName !== undefined &&
    !matchesTextOrRegex(call.serviceName, criteria.serviceName)
  ) {
    return false;
  }
  return true;
}

function formatTriggerDescription(filter: ClientTriggerFilter | undefined): string {
  if (!filter) return "any client API request";
  const method = filter.method ? `${filter.method.toUpperCase()} ` : "";
  const pathText = filter.path instanceof RegExp ? filter.path.toString() : filter.path;
  const originText = filter.origin ? ` on ${filter.origin}` : "";
  return `${method}${pathText}${originText}`;
}

function formatObservedCalls(calls: readonly OutboundHttpCall[]): string {
  if (calls.length === 0) return "none";
  return calls
    .map((call) => `${call.method} ${call.url} (status ${call.status})`)
    .join(", ");
}

function formatCallCriteria(criteria: {
  readonly method?: string;
  readonly url?: string | RegExp;
  readonly status?: StatusMatcher;
  readonly serviceName?: string | RegExp;
}): string {
  const parts: string[] = [];
  if (criteria.method) parts.push(`method=${criteria.method.toUpperCase()}`);
  if (criteria.url !== undefined) {
    parts.push(
      `url=${criteria.url instanceof RegExp ? criteria.url.toString() : criteria.url}`,
    );
  }
  if (criteria.status !== undefined) {
    parts.push(
      `status=${typeof criteria.status === "number" ? String(criteria.status) : `[${criteria.status[0]}..${criteria.status[1]}]`}`,
    );
  }
  if (criteria.serviceName !== undefined) {
    parts.push(
      `serviceName=${criteria.serviceName instanceof RegExp ? criteria.serviceName.toString() : criteria.serviceName}`,
    );
  }
  return parts.length > 0 ? parts.join(", ") : "any outbound HTTP call";
}

async function waitForMatchingTrigger(
  triggerSource: TriggerSource,
  filter: ClientTriggerFilter | undefined,
  deadlineMs: number,
  intervalMs: number,
  signal?: AbortSignal,
): Promise<RecordedClientTrigger> {
  switch (triggerSource.kind) {
    case "ledger": {
      // In-memory route interception records requests before fetch resolves, so cap trigger wait at 1,500ms to fail fast on route mismatches.
      const triggerWaitCapMs = Math.min(deadlineMs, Date.now() + 1_500);
      for (;;) {
        const entries = triggerSource.readTriggers();
        const match = selectLatestMatchingTrigger(entries, filter);
        if (match !== undefined) {
          return match;
        }
        if (Date.now() >= triggerWaitCapMs) {
          const recordedSummary =
            entries.length === 0
              ? "none"
              : entries.map((e) => `${e.method} ${e.pathname}`).join(", ");
          throw new TraceAssertionError({
            message: `No browser API request in the active TraceScope matched triggeredBy (${formatTriggerDescription(filter)}). Recorded triggers: ${recordedSummary}.`,
          });
        }
        await sleep(Math.min(25, Math.max(1, triggerWaitCapMs - Date.now())), signal);
      }
    }
    case "session": {
      // OTLP session spans flush asynchronously over HTTP to TheLake, so poll up to the full deadlineMs without the in-memory ledger cap.
      let lastEntries: readonly RecordedClientTrigger[] = [];
      let lastTransientError: string | undefined;
      for (;;) {
        const remainingMs = deadlineMs - Date.now();
        const perCallTimeoutMs = Math.max(250, Math.min(Math.max(1, remainingMs), 5_000));
        const timeoutSignal = AbortSignal.timeout(perCallTimeoutMs);
        const combinedSignal = signal
          ? AbortSignal.any([signal, timeoutSignal])
          : timeoutSignal;

        try {
          const entries = await triggerSource.fetchSessionTriggers(combinedSignal);
          lastEntries = entries;
          lastTransientError = undefined;
          const match = selectLatestMatchingTrigger(entries, filter);
          if (match !== undefined) {
            return match;
          }
        } catch (error) {
          if (signal?.aborted) {
            throw error;
          }
          if (error instanceof SinkHttpError && !error.retryable) {
            throw error;
          }
          lastTransientError = error instanceof Error ? error.message : String(error);
        }

        if (Date.now() >= deadlineMs) {
          const recordedSummary =
            lastEntries.length === 0
              ? "none"
              : lastEntries.map((e) => `${e.method} ${e.pathname}`).join(", ");
          const errorSuffix = lastTransientError
            ? ` Last session query error was ${lastTransientError}.`
            : "";
          throw new TraceAssertionError({
            message: `No session HTTP span in session ${triggerSource.sessionId} matched triggeredBy (${formatTriggerDescription(filter)}). Recorded triggers: ${recordedSummary}.${errorSuffix}`,
          });
        }
        await sleep(Math.min(intervalMs, Math.max(1, deadlineMs - Date.now())), signal);
      }
    }
    default: {
      const _exhaustive: never = triggerSource;
      return _exhaustive;
    }
  }
}

async function pollSingleSnapshot(
  sink: TraceSink,
  traceId: TraceId,
  remainingMs: number,
  outerSignal?: AbortSignal,
): Promise<{
  readonly snapshot?: TracePollSnapshot;
  readonly transientError?: string;
}> {
  const perCallTimeoutMs = Math.max(250, Math.min(remainingMs, 5_000));
  const timeoutSignal = AbortSignal.timeout(perCallTimeoutMs);
  const combinedSignal = outerSignal
    ? AbortSignal.any([outerSignal, timeoutSignal])
    : timeoutSignal;

  try {
    const snapshot = await sink.fetchTrace(traceId, combinedSignal);
    return { snapshot };
  } catch (error) {
    if (outerSignal?.aborted) {
      throw error;
    }
    if (error instanceof SinkHttpError && !error.retryable) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    return { transientError: message };
  }
}

export interface PollerContext {
  readonly triggerSource: TriggerSource;
  readonly sink: TraceSink;
  readonly defaults: SoftprobePollingDefaults;
  readonly signal?: AbortSignal;
  readonly onVerifiedTrace?: (event: VerifiedTraceEvent) => void;
}

export async function pollOutboundHttp(
  ctx: PollerContext,
  query: OutboundHttpQuery,
): Promise<OutboundHttpCall> {
  const timeoutMs =
    query.pollTimeoutMs ?? query.timeoutMs ?? ctx.defaults.pollTimeoutMs;
  const intervalMs = query.pollIntervalMs ?? ctx.defaults.pollIntervalMs;
  const startedMs = Date.now();
  const deadlineMs = startedMs + timeoutMs;

  const trigger = await waitForMatchingTrigger(
    ctx.triggerSource,
    query.triggeredBy,
    deadlineMs,
    intervalMs,
    ctx.signal,
  );
  const explorerTraceUrl = ctx.sink.buildExplorerTraceUrl(trigger.traceId);

  let latestIngested: Extract<TracePollSnapshot, { state: "ingested" }> | undefined;
  let lastTransientError: string | undefined;

  for (;;) {
    const remainingMs = deadlineMs - Date.now();
    const outcome = await pollSingleSnapshot(
      ctx.sink,
      trigger.traceId,
      Math.max(1, remainingMs),
      ctx.signal,
    );
    if (outcome.transientError !== undefined) {
      lastTransientError = outcome.transientError;
    } else if (outcome.snapshot !== undefined) {
      lastTransientError = undefined;
      if (outcome.snapshot.state === "ingested") {
        latestIngested = outcome.snapshot;
        const matched = outcome.snapshot.outboundHttp.find((call) =>
          matchesOutboundCall(call, query),
        );
        if (matched !== undefined) {
          ctx.onVerifiedTrace?.({
            traceId: trigger.traceId,
            sinkKind: ctx.sink.kind,
            sinkUrl: ctx.sink.sinkUrl,
            mode: "outboundHttp",
            trigger,
            matchedCall: matched,
            ...(explorerTraceUrl ? { explorerTraceUrl } : {}),
          });
          return matched;
        }
      }
    }

    if (Date.now() >= deadlineMs) {
      break;
    }
    await sleep(Math.min(intervalMs, Math.max(1, deadlineMs - Date.now())), ctx.signal);
  }

  if (latestIngested === undefined) {
    throw new TraceInstrumentationError({
      traceId: trigger.traceId,
      triggerMethod: trigger.method,
      triggerPath: trigger.pathname,
      sinkUrl: ctx.sink.sinkUrl,
      timeoutMs,
      ...(explorerTraceUrl ? { explorerTraceUrl } : {}),
      ...(lastTransientError ? { causeMessage: lastTransientError } : {}),
    });
  }

  const linkSuffix = explorerTraceUrl ? ` Inspect trace at ${explorerTraceUrl}.` : "";
  throw new TraceAssertionError({
    message: `No outbound HTTP call on trace ${trigger.traceId} matched (${formatCallCriteria(query)}) within ${timeoutMs}ms. Observed outbound calls: ${formatObservedCalls(latestIngested.outboundHttp)}.${linkSuffix}`,
    traceId: trigger.traceId,
    observedCalls: latestIngested.outboundHttp,
    ...(explorerTraceUrl ? { explorerTraceUrl } : {}),
  });
}

export async function pollExpectNoOutboundHttp(
  ctx: PollerContext,
  query: ExpectNoOutboundHttpQuery = {},
): Promise<void> {
  const timeoutMs =
    query.pollTimeoutMs ?? query.timeoutMs ?? ctx.defaults.pollTimeoutMs;
  const intervalMs = query.pollIntervalMs ?? ctx.defaults.pollIntervalMs;
  const settleMs = query.settleMs ?? ctx.defaults.settleMs;
  const startedMs = Date.now();
  const deadlineMs = startedMs + timeoutMs;

  const trigger = await waitForMatchingTrigger(
    ctx.triggerSource,
    query.triggeredBy,
    deadlineMs,
    intervalMs,
    ctx.signal,
  );
  const explorerTraceUrl = ctx.sink.buildExplorerTraceUrl(trigger.traceId);

  let ingestedSnapshot: Extract<TracePollSnapshot, { state: "ingested" }> | undefined;
  let lastTransientError: string | undefined;

  for (;;) {
    const remainingMs = deadlineMs - Date.now();
    const outcome = await pollSingleSnapshot(
      ctx.sink,
      trigger.traceId,
      Math.max(1, remainingMs),
      ctx.signal,
    );
    if (outcome.transientError !== undefined) {
      lastTransientError = outcome.transientError;
    } else if (outcome.snapshot !== undefined) {
      lastTransientError = undefined;
      if (outcome.snapshot.state === "ingested") {
        ingestedSnapshot = outcome.snapshot;
        break;
      }
    }

    if (Date.now() >= deadlineMs) {
      break;
    }
    await sleep(Math.min(intervalMs, Math.max(1, deadlineMs - Date.now())), ctx.signal);
  }

  if (ingestedSnapshot === undefined) {
    throw new TraceInstrumentationError({
      traceId: trigger.traceId,
      triggerMethod: trigger.method,
      triggerPath: trigger.pathname,
      sinkUrl: ctx.sink.sinkUrl,
      timeoutMs,
      ...(explorerTraceUrl ? { explorerTraceUrl } : {}),
      ...(lastTransientError ? { causeMessage: lastTransientError } : {}),
    });
  }

  const checkForbiddenCalls = (calls: readonly OutboundHttpCall[]) => {
    const violating = calls.filter((call) => matchesOutboundCall(call, query));
    if (violating.length > 0) {
      const linkSuffix = explorerTraceUrl
        ? ` Inspect trace at ${explorerTraceUrl}.`
        : "";
      throw new TraceAssertionError({
        message: `Expected zero outbound HTTP calls matching (${formatCallCriteria(query)}) on trace ${trigger.traceId}, found ${violating.length}: ${formatObservedCalls(violating)}.${linkSuffix}`,
        traceId: trigger.traceId,
        observedCalls: calls,
        ...(explorerTraceUrl ? { explorerTraceUrl } : {}),
      });
    }
  };

  checkForbiddenCalls(ingestedSnapshot.outboundHttp);

  const settleBudgetMs = Math.min(settleMs, Math.max(0, deadlineMs - Date.now()));
  if (settleBudgetMs > 0) {
    await sleep(settleBudgetMs, ctx.signal);
    const settledOutcome = await pollSingleSnapshot(
      ctx.sink,
      trigger.traceId,
      Math.max(250, deadlineMs - Date.now()),
      ctx.signal,
    );
    if (
      settledOutcome.snapshot !== undefined &&
      settledOutcome.snapshot.state === "ingested"
    ) {
      checkForbiddenCalls(settledOutcome.snapshot.outboundHttp);
    }
  }

  ctx.onVerifiedTrace?.({
    traceId: trigger.traceId,
    sinkKind: ctx.sink.kind,
    sinkUrl: ctx.sink.sinkUrl,
    mode: "expectNoOutboundHttp",
    trigger,
    ...(explorerTraceUrl ? { explorerTraceUrl } : {}),
  });
}
