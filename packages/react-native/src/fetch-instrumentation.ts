import {
  context,
  SpanKind,
  SpanStatusCode,
  TraceFlags,
  trace,
  type Tracer,
} from "@opentelemetry/api";
import { isTracingSuppressed } from "@opentelemetry/core";
import {
  compileOriginAllowlist,
  contextWithSessionBaggage,
  inferAmbientOrigin,
  isIgnoredUrl,
  matchCaptureRoute,
  mergeBaggageWithSession,
  normalizeBodyCapture,
  readSpanSessionAttribute,
  resolveHttpUrl,
  sanitizeJsonBodyText,
  scrubHeaderEntries,
} from "./http-helpers.js";
import {
  parseMobileSessionId,
  type InstrumentedFetchHandle,
  type InstrumentReactNativeFetchOptions,
} from "./types.js";

function resolveRequestUrl(
  input: Parameters<typeof fetch>[0],
  baseOrigin: string | undefined,
): URL | null {
  const rawUrl =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : typeof input === "object" && input !== null && "url" in input
          ? String(input.url)
          : "";
  return resolveHttpUrl(rawUrl, baseOrigin);
}

function resolveRequestMethod(
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
): string {
  if (typeof init?.method === "string" && init.method.trim()) {
    return init.method.trim().toUpperCase();
  }
  if (
    typeof Request !== "undefined" &&
    input instanceof Request &&
    input.method.trim()
  ) {
    return input.method.trim().toUpperCase();
  }
  return "GET";
}

function mergeRequestHeaders(
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
): Headers {
  const headers = new Headers(
    typeof Request !== "undefined" && input instanceof Request
      ? input.headers
      : undefined,
  );
  if (init?.headers) {
    new Headers(init.headers).forEach((value, key) => {
      headers.set(key, value);
    });
  }
  return headers;
}

async function readCandidateRequestBody(
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
): Promise<string | undefined> {
  if (typeof init?.body === "string") {
    return init.body;
  }
  if (
    init?.body === undefined &&
    typeof Request !== "undefined" &&
    input instanceof Request &&
    !input.bodyUsed
  ) {
    try {
      return await input.clone().text();
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function instrumentReactNativeFetch(
  options: InstrumentReactNativeFetchOptions,
): InstrumentedFetchHandle {
  const tracerOption = options.tracer;
  const getTracer: () => Tracer =
    typeof tracerOption === "function" ? tracerOption : () => tracerOption;
  const ambientOrigin = inferAmbientOrigin(options.baseOrigin);
  const allowedOrigins = compileOriginAllowlist(options.apiOrigins);
  const bodyCapture = normalizeBodyCapture(
    options.httpBodyCapture,
    options.redactJsonPaths,
  );

  const patchTarget: { fetch: typeof fetch } | undefined =
    options.target ??
    (options.fetchImpl === undefined && typeof globalThis.fetch === "function"
      ? globalThis
      : undefined);

  const originalFetch = options.fetchImpl ?? patchTarget?.fetch;
  if (typeof originalFetch !== "function") {
    throw new Error(
      "instrumentReactNativeFetch requires either `fetchImpl`, `target.fetch`, or global `fetch`",
    );
  }
  const rawFetch: typeof fetch = patchTarget
    ? originalFetch.bind(patchTarget)
    : originalFetch;

  let active = true;

  const wrappedFetch: typeof fetch & {
    __softprobeOriginalFetch?: typeof fetch;
  } = async (input, init) => {
    if (!active || isTracingSuppressed(context.active())) {
      return rawFetch(input, init);
    }

    const parsedUrl = resolveRequestUrl(input, ambientOrigin);
    if (!parsedUrl || isIgnoredUrl(parsedUrl.href, options.ignoreUrls)) {
      return rawFetch(input, init);
    }
    if (allowedOrigins !== null && !allowedOrigins.has(parsedUrl.origin)) {
      return rawFetch(input, init);
    }

    const method = resolveRequestMethod(input, init);
    const matchedBodyRoute = bodyCapture
      ? matchCaptureRoute(bodyCapture, method, parsedUrl)
      : null;

    const parentCtx = contextWithSessionBaggage(
      context.active(),
      options.getSessionId(),
    );
    const span = getTracer().startSpan(
      `HTTP ${method}`,
      {
        kind: SpanKind.CLIENT,
        attributes: {
          "http.request.method": method,
          "http.method": method,
          "url.full": parsedUrl.href,
          "http.url": parsedUrl.href,
          "url.path": parsedUrl.pathname || "/",
          "url.scheme": parsedUrl.protocol.replace(/:$/, ""),
          "server.address": parsedUrl.hostname,
          ...(parsedUrl.port ? { "server.port": Number(parsedUrl.port) } : {}),
          ...(parsedUrl.search ? { "url.query": parsedUrl.search.slice(1) } : {}),
          ...(matchedBodyRoute?.urlTemplate
            ? { "url.template": matchedBodyRoute.urlTemplate }
            : {}),
        },
      },
      parentCtx,
    );

    const spanCtx = span.spanContext();
    const sampledHex =
      (spanCtx.traceFlags & TraceFlags.SAMPLED) === TraceFlags.SAMPLED ? "01" : "00";
    const traceparent = `00-${spanCtx.traceId}-${spanCtx.spanId}-${sampledHex}`;

    const headers = mergeRequestHeaders(input, init);
    headers.set("traceparent", traceparent);

    const spanSessionAttr = readSpanSessionAttribute(span);
    const effectiveSessionId =
      parseMobileSessionId(spanSessionAttr) ??
      parseMobileSessionId(options.getSessionId());
    const mergedBaggage = mergeBaggageWithSession(
      headers.get("baggage"),
      parentCtx,
      effectiveSessionId,
    );
    if (mergedBaggage) {
      headers.set("baggage", mergedBaggage);
    }

    const scrubbedReqHeaders = scrubHeaderEntries(headers.entries());
    if (scrubbedReqHeaders) {
      span.setAttribute("http.request.headers", scrubbedReqHeaders);
    }

    options.actionRecorder?.onHttpSpanStart({
      traceId: spanCtx.traceId,
      spanId: spanCtx.spanId,
      method,
      url: parsedUrl.href,
      ...(matchedBodyRoute?.urlTemplate
        ? { urlTemplate: matchedBodyRoute.urlTemplate }
        : {}),
    });

    const requestBodyPromise =
      bodyCapture && matchedBodyRoute
        ? readCandidateRequestBody(input, init).then((rawReq) =>
            sanitizeJsonBodyText(
              rawReq,
              bodyCapture.maxBodyBytes,
              matchedBodyRoute.redactPaths,
            ),
          )
        : Promise.resolve(undefined);

    const spanActiveCtx = trace.setSpan(parentCtx, span);
    let responseStatus: number | undefined;

    try {
      const nextInit: RequestInit = {
        ...init,
        method,
        headers,
      };
      const response = await context.with(spanActiveCtx, () =>
        typeof Request !== "undefined" && input instanceof Request
          ? rawFetch(new Request(input, nextInit))
          : rawFetch(parsedUrl.href, nextInit),
      );

      responseStatus = response.status;
      span.setAttribute("http.response.status_code", response.status);
      span.setAttribute("http.status_code", response.status);

      const scrubbedResHeaders = scrubHeaderEntries(response.headers.entries());
      if (scrubbedResHeaders) {
        span.setAttribute("http.response.headers", scrubbedResHeaders);
      }

      if (bodyCapture && matchedBodyRoute) {
        const reqBody = await requestBodyPromise;
        let resBody: string | undefined;
        const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
        if (
          (contentType.includes("json") || contentType === "") &&
          typeof response.clone === "function"
        ) {
          const rawResText = await response
            .clone()
            .text()
            .catch(() => undefined);
          resBody = sanitizeJsonBodyText(
            rawResText,
            bodyCapture.maxBodyBytes,
            matchedBodyRoute.redactPaths,
          );
        }
        if (reqBody !== undefined) {
          span.setAttribute("http.request.body", reqBody);
        }
        if (resBody !== undefined) {
          span.setAttribute("http.response.body", resBody);
        }
        span.setAttribute(
          "sp.body.capture.status",
          reqBody !== undefined || resBody !== undefined ? "captured" : "omitted",
        );
      }

      if (response.status >= 500) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: `HTTP ${response.status}`,
        });
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
      }

      return response;
    } catch (error) {
      if (bodyCapture && matchedBodyRoute) {
        const reqBody = await requestBodyPromise.catch(() => undefined);
        if (reqBody !== undefined) {
          span.setAttribute("http.request.body", reqBody);
        }
      }
      if (error instanceof Error) {
        span.recordException(error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      } else {
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
      }
      throw error;
    } finally {
      span.end();
      options.actionRecorder?.onHttpSpanEnd({
        traceId: spanCtx.traceId,
        spanId: spanCtx.spanId,
        method,
        url: parsedUrl.href,
        ...(matchedBodyRoute?.urlTemplate
          ? { urlTemplate: matchedBodyRoute.urlTemplate }
          : {}),
        ...(responseStatus !== undefined ? { status: responseStatus } : {}),
      });
    }
  };

  wrappedFetch.__softprobeOriginalFetch = rawFetch;

  if (patchTarget) {
    patchTarget.fetch = wrappedFetch;
  }

  return {
    fetch: wrappedFetch,
    uninstall(): void {
      if (!active) return;
      active = false;
      if (patchTarget && patchTarget.fetch === wrappedFetch) {
        patchTarget.fetch = originalFetch;
      }
    },
  };
}
