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
  BAGGAGE_SESSION_KEY,
  parseMobileSessionId,
  type InstrumentedXhrHandle,
  type InstrumentReactNativeXhrOptions,
  type XmlHttpRequestConstructorLike,
  type XmlHttpRequestLike,
} from "./types.js";

interface XhrRequestState {
  method: string;
  rawUrl: string;
  headers: Map<string, string>;
  abortPrevious?: () => void;
}

function parseRawResponseHeaders(raw: string | undefined): Array<[string, string]> {
  if (!raw) return [];
  const entries: Array<[string, string]> = [];
  for (const line of raw.split(/\r?\n/)) {
    const colonIdx = line.indexOf(":");
    if (colonIdx <= 0) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key) {
      entries.push([key, value]);
    }
  }
  return entries;
}

function readXhrResponseText(xhr: XmlHttpRequestLike): string | undefined {
  try {
    if (typeof xhr.responseText === "string") {
      return xhr.responseText;
    }
  } catch {
    // Accessing responseText throws on non-text responseType in standard XHR.
  }
  if (typeof xhr.response === "string") {
    return xhr.response;
  }
  return undefined;
}

function readXhrContentType(xhr: XmlHttpRequestLike): string {
  try {
    return (xhr.getResponseHeader?.("content-type") ?? "").toLowerCase();
  } catch {
    return "";
  }
}

export function instrumentReactNativeXhr(
  options: InstrumentReactNativeXhrOptions,
): InstrumentedXhrHandle {
  const tracerOption = options.tracer;
  const getTracer: () => Tracer =
    typeof tracerOption === "function" ? tracerOption : () => tracerOption;
  const ambientOrigin = inferAmbientOrigin(options.baseOrigin);
  const allowedOrigins = compileOriginAllowlist(options.apiOrigins);
  const bodyCapture = normalizeBodyCapture(
    options.httpBodyCapture,
    options.redactJsonPaths,
  );

  const patchHost =
    options.target ??
    (typeof globalThis !== "undefined"
      ? (globalThis as { XMLHttpRequest?: XmlHttpRequestConstructorLike })
      : undefined);
  const XhrCtor = options.xhrConstructor ?? patchHost?.XMLHttpRequest;

  if (
    !XhrCtor?.prototype ||
    typeof XhrCtor.prototype.open !== "function" ||
    typeof XhrCtor.prototype.setRequestHeader !== "function" ||
    typeof XhrCtor.prototype.send !== "function"
  ) {
    return { uninstall(): void {} };
  }

  const proto = XhrCtor.prototype;
  const origOpen = proto.open;
  const origSetRequestHeader = proto.setRequestHeader;
  const origSend = proto.send;

  const stateByInstance = new WeakMap<XmlHttpRequestLike, XhrRequestState>();
  let active = true;

  const wrappedOpen: XmlHttpRequestLike["open"] = function (
    this: XmlHttpRequestLike,
    method: string,
    url: string,
    async?: boolean,
    user?: string | null,
    password?: string | null,
  ): void {
    if (active) {
      const prev = stateByInstance.get(this);
      prev?.abortPrevious?.();
      stateByInstance.set(this, {
        method: String(method || "GET").trim().toUpperCase(),
        rawUrl: String(url ?? ""),
        headers: new Map(),
      });
    }
    return origOpen.call(this, method, url, async, user, password);
  };

  const wrappedSetRequestHeader: XmlHttpRequestLike["setRequestHeader"] = function (
    this: XmlHttpRequestLike,
    name: string,
    value: string,
  ): void {
    if (active) {
      const state = stateByInstance.get(this);
      const lower = String(name).trim().toLowerCase();
      if (state && lower) {
        const existing = state.headers.get(lower);
        state.headers.set(
          lower,
          existing !== undefined ? `${existing}, ${String(value)}` : String(value),
        );
      }
    }
    return origSetRequestHeader.call(this, name, value);
  };

  const wrappedSend: XmlHttpRequestLike["send"] = function (
    this: XmlHttpRequestLike,
    body?: unknown,
  ): void {
    if (!active || isTracingSuppressed(context.active())) {
      return origSend.call(this, body);
    }

    const state = stateByInstance.get(this);
    if (!state) {
      return origSend.call(this, body);
    }

    const parsedUrl = resolveHttpUrl(state.rawUrl, ambientOrigin);
    if (!parsedUrl || isIgnoredUrl(parsedUrl.href, options.ignoreUrls)) {
      return origSend.call(this, body);
    }
    if (allowedOrigins !== null && !allowedOrigins.has(parsedUrl.origin)) {
      return origSend.call(this, body);
    }

    const method = state.method || "GET";
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

    const spanSessionAttr = readSpanSessionAttribute(span);
    const effectiveSessionId =
      parseMobileSessionId(spanSessionAttr) ??
      parseMobileSessionId(options.getSessionId());
    if (effectiveSessionId) {
      span.setAttribute("sp.session.id", effectiveSessionId);
      span.setAttribute("session.id", effectiveSessionId);
    }

    if (!state.headers.has("traceparent")) {
      origSetRequestHeader.call(this, "traceparent", traceparent);
      state.headers.set("traceparent", traceparent);
    }

    const existingBaggage = state.headers.get("baggage") ?? null;
    const mergedBaggage = mergeBaggageWithSession(
      existingBaggage,
      parentCtx,
      effectiveSessionId,
    );
    if (mergedBaggage && mergedBaggage !== existingBaggage) {
      if (existingBaggage && effectiveSessionId) {
        origSetRequestHeader.call(
          this,
          "baggage",
          `${BAGGAGE_SESSION_KEY}=${effectiveSessionId}`,
        );
      } else {
        origSetRequestHeader.call(this, "baggage", mergedBaggage);
      }
      state.headers.set("baggage", mergedBaggage);
    }

    const scrubbedReqHeaders = scrubHeaderEntries(state.headers.entries());
    if (scrubbedReqHeaders) {
      span.setAttribute("http.request.headers", scrubbedReqHeaders);
    }

    const reqBody =
      bodyCapture && matchedBodyRoute && typeof body === "string"
        ? sanitizeJsonBodyText(
            body,
            bodyCapture.maxBodyBytes,
            matchedBodyRoute.redactPaths,
          )
        : undefined;
    if (reqBody !== undefined) {
      span.setAttribute("http.request.body", reqBody);
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

    let finished = false;
    let detachListeners = (): void => {};

    const finishSpan = (statusOverride?: number): void => {
      if (finished) return;
      finished = true;
      state.abortPrevious = undefined;
      detachListeners();

      const status =
        statusOverride ??
        (typeof this.status === "number" && this.status > 0
          ? this.status
          : undefined);

      if (status !== undefined) {
        span.setAttribute("http.response.status_code", status);
        span.setAttribute("http.status_code", status);
      }

      const rawResHeaders =
        typeof this.getAllResponseHeaders === "function"
          ? this.getAllResponseHeaders()
          : undefined;
      const scrubbedResHeaders = scrubHeaderEntries(
        parseRawResponseHeaders(rawResHeaders),
      );
      if (scrubbedResHeaders) {
        span.setAttribute("http.response.headers", scrubbedResHeaders);
      }

      if (bodyCapture && matchedBodyRoute) {
        const contentType = readXhrContentType(this);
        const rawResText = readXhrResponseText(this);
        const resBody =
          (contentType.includes("json") || contentType === "") &&
          rawResText !== undefined
            ? sanitizeJsonBodyText(
                rawResText,
                bodyCapture.maxBodyBytes,
                matchedBodyRoute.redactPaths,
              )
            : undefined;
        if (resBody !== undefined) {
          span.setAttribute("http.response.body", resBody);
        }
        span.setAttribute(
          "sp.body.capture.status",
          reqBody !== undefined || resBody !== undefined ? "captured" : "omitted",
        );
      }

      if (status === undefined || status >= 500) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: status !== undefined ? `HTTP ${status}` : "XHR request failed",
        });
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
      }

      span.end();
      options.actionRecorder?.onHttpSpanEnd({
        traceId: spanCtx.traceId,
        spanId: spanCtx.spanId,
        method,
        url: parsedUrl.href,
        ...(matchedBodyRoute?.urlTemplate
          ? { urlTemplate: matchedBodyRoute.urlTemplate }
          : {}),
        ...(status !== undefined ? { status } : {}),
      });
    };

    state.abortPrevious = () => finishSpan(undefined);

    if (typeof this.addEventListener === "function") {
      const onLoadEnd = (): void => finishSpan();
      this.addEventListener("loadend", onLoadEnd);
      detachListeners = () => {
        this.removeEventListener?.("loadend", onLoadEnd);
      };
    } else {
      const prevReadyStateChange = this.onreadystatechange ?? null;
      const wrappedReadyStateChange = (): void => {
        prevReadyStateChange?.call(this);
        if (this.readyState === 4) {
          finishSpan();
        }
      };
      this.onreadystatechange = wrappedReadyStateChange;
      detachListeners = () => {
        if (this.onreadystatechange === wrappedReadyStateChange) {
          this.onreadystatechange = prevReadyStateChange;
        }
      };
    }

    const spanActiveCtx = trace.setSpan(parentCtx, span);
    try {
      return context.with(spanActiveCtx, () => origSend.call(this, body));
    } catch (error) {
      if (!finished) {
        finished = true;
        state.abortPrevious = undefined;
        detachListeners();
        if (error instanceof Error) {
          span.recordException(error);
          span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        } else {
          span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
        }
        span.end();
        options.actionRecorder?.onHttpSpanEnd({
          traceId: spanCtx.traceId,
          spanId: spanCtx.spanId,
          method,
          url: parsedUrl.href,
          ...(matchedBodyRoute?.urlTemplate
            ? { urlTemplate: matchedBodyRoute.urlTemplate }
            : {}),
        });
      }
      throw error;
    }
  };

  proto.open = wrappedOpen;
  proto.setRequestHeader = wrappedSetRequestHeader;
  proto.send = wrappedSend;

  return {
    uninstall(): void {
      if (!active) return;
      active = false;
      if (proto.open === wrappedOpen) proto.open = origOpen;
      if (proto.setRequestHeader === wrappedSetRequestHeader) {
        proto.setRequestHeader = origSetRequestHeader;
      }
      if (proto.send === wrappedSend) proto.send = origSend;
    },
  };
}
