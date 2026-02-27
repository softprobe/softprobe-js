import { Readable } from 'stream';
import { BatchInterceptor } from '@mswjs/interceptors';
import { ClientRequestInterceptor } from '@mswjs/interceptors/ClientRequest';
import { FetchInterceptor } from '@mswjs/interceptors/fetch';
import { trace } from '@opentelemetry/api';
import { SoftprobeContext } from '../context';
import { ConfigManager } from '../config/config-manager';
import { httpIdentifier } from '../identifier';
import type { MatcherAction } from '../types/schema';
import { HttpSpan } from '../bindings/http-span';
import { setCaptureUsesInterceptor } from '../capture/store-accessor';
import { tapReadableStream } from '../capture/stream-tap';
import { applyUndiciFetchAsGlobal } from './undici';

type RequestController = { respondWith: (response: Response) => void };
type RequestEvent = { request: Request; controller: RequestController };

const DEFAULT_MAX_PAYLOAD_SIZE = 1_048_576;
let cachedMaxPayloadSize: number | null = null;

function getCaptureMaxPayloadSize(): number {
  if (cachedMaxPayloadSize != null) return cachedMaxPayloadSize;
  try {
    const cfg = new ConfigManager();
    const n = (cfg.get().capture as { maxPayloadSize?: number } | undefined)?.maxPayloadSize;
    cachedMaxPayloadSize = typeof n === 'number' && n > 0 ? n : DEFAULT_MAX_PAYLOAD_SIZE;
  } catch {
    cachedMaxPayloadSize = DEFAULT_MAX_PAYLOAD_SIZE;
  }
  return cachedMaxPayloadSize;
}

type HttpReplayOptions = {
  shouldIgnoreUrl?: (url?: string) => boolean;
  /** When set and mode is CAPTURE, used to perform the real request (avoids re-entering the interceptor). */
  bypassFetch?: (input: Request | string | URL, init?: RequestInit) => Promise<Response>;
};

let cachedConfig: ConfigManager | null = null;
let cachedConfigInitFailed = false;

function shouldIgnoreFromConfig(url?: string): boolean {
  if (cachedConfigInitFailed) return false;
  try {
    if (cachedConfig == null) cachedConfig = new ConfigManager();
    return cachedConfig.shouldIgnore(url);
  } catch {
    cachedConfigInitFailed = true;
    return false;
  }
}

function jsonErrorResponse(message: string, details?: string): Response {
  const payload = details ? { error: message, details } : { error: message };
  return new Response(JSON.stringify(payload), {
    status: 500,
    headers: {
      'x-softprobe-error': 'true',
      'content-type': 'application/json',
    },
  });
}

/** Serializes body for mock response. Returns '{}' when body is missing so consumer .json() does not throw. */
function toTextBody(body: unknown): string {
  if (typeof body === 'string') return body;
  if (body == null) return '{}';
  return JSON.stringify(body);
}

/**
 * CAPTURE branch: perform request with bypass fetch, tap response body via tapReadableStream,
 * build outbound record, saveRecord (fire-and-forget), respondWith(tapped response).
 */
async function handleCaptureRequest(
  request: Request,
  controller: RequestController,
  bypassFetch: (input: Request | string | URL, init?: RequestInit) => Promise<Response>
): Promise<void> {
  const method = (request.method ?? 'GET').toUpperCase();
  const url = typeof request.url === 'string' ? request.url : String(request.url);
  const identifier = httpIdentifier(method, url);
  const span = trace.getActiveSpan();
  const ctx = span?.spanContext();
  const traceId = ctx?.traceId ?? '';
  const spanId = ctx?.spanId ?? '';
  const parentSpanId = span && 'parentSpanId' in span ? (span as { parentSpanId?: string }).parentSpanId : undefined;
  const spanName = span && 'name' in span ? (span as { name?: string }).name : undefined;
  // Capture cassette/traceId before any await so async callbacks (e.g. getCaptured().then) still have them (Task 13.11).
  const cassette = SoftprobeContext.getCassette();
  const softprobeTraceId = SoftprobeContext.getTraceId();

  const urlString = typeof url === 'string' ? url : String(url);
  let response: Response;
  try {
    const input = urlString.startsWith('http:') || urlString.startsWith('https:') ? new URL(urlString) : urlString;
    response = await bypassFetch(input, {
      method: request.method ?? 'GET',
      headers: request.headers,
      body: request.body ?? undefined,
      duplex: (request as Request & { duplex?: string }).duplex,
    });
  } catch (err) {
    const details = err instanceof Error ? err.message : String(err);
    controller.respondWith(jsonErrorResponse('Softprobe Capture fetch failed', details));
    return;
  }

  if (!response.body) {
    controller.respondWith(response);
    if (SoftprobeContext.getMode() === 'CAPTURE' && cassette) {
      const rec = {
        version: '4.1' as const,
        traceId,
        spanId,
        parentSpanId,
        spanName,
        timestamp: new Date().toISOString(),
        type: 'outbound' as const,
        protocol: 'http' as const,
        identifier,
        responsePayload: { statusCode: response.status },
      };
      void cassette.saveRecord(softprobeTraceId ? { ...rec, traceId: softprobeTraceId } : rec).catch(() => {});
    }
    return;
  }

  const maxPayloadSize = getCaptureMaxPayloadSize();
  const fromWeb = (Readable as unknown as { fromWeb?: (s: unknown) => NodeJS.ReadableStream }).fromWeb;
  const toWeb = (Readable as unknown as { toWeb?: (s: NodeJS.ReadableStream) => unknown }).toWeb;

  if (typeof fromWeb === 'function' && typeof toWeb === 'function') {
    try {
      const nodeReadable = fromWeb(response.body) as import('stream').Readable;
      const { readable, getCaptured } = tapReadableStream(nodeReadable, { maxPayloadSize });
      const webStream = toWeb(readable);
      const newResponse = new Response(webStream as never, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
      controller.respondWith(newResponse);
      getCaptured()
        .then((captured) => {
          if (SoftprobeContext.getMode() !== 'CAPTURE' || !cassette) return;
          const bodyStr = captured.body.toString('utf8');
          const rec = {
            version: '4.1' as const,
            traceId,
            spanId,
            parentSpanId,
            spanName,
            timestamp: new Date().toISOString(),
            type: 'outbound' as const,
            protocol: 'http' as const,
            identifier,
            responsePayload: {
              statusCode: response.status,
              body: bodyStr,
              ...(captured.truncated && { truncated: true }),
            },
          };
          void cassette.saveRecord(softprobeTraceId ? { ...rec, traceId: softprobeTraceId } : rec).catch(() => {});
        })
        .catch(() => {});
    } catch {
      controller.respondWith(response);
    }
  } else {
    response
      .clone()
      .text()
      .then((bodyText) => {
        if (SoftprobeContext.getMode() !== 'CAPTURE' || !cassette) return;
        const capped = bodyText.length > maxPayloadSize ? bodyText.slice(0, maxPayloadSize) : bodyText;
        const rec = {
          version: '4.1' as const,
          traceId,
          spanId,
          parentSpanId,
          spanName,
          timestamp: new Date().toISOString(),
          type: 'outbound' as const,
          protocol: 'http' as const,
          identifier,
          responsePayload: {
            statusCode: response.status,
            body: capped,
            ...(bodyText.length > maxPayloadSize && { truncated: true }),
          },
        };
        void cassette.saveRecord(softprobeTraceId ? { ...rec, traceId: softprobeTraceId } : rec).catch(() => {});
      })
      .catch(() => {});
    controller.respondWith(response);
  }
}

export async function handleHttpReplayRequest(
  event: RequestEvent,
  options: HttpReplayOptions = {}
): Promise<void> {
  const { request, controller } = event;

  try {
    const url = typeof request.url === 'string' ? request.url : String(request.url);
    const shouldIgnore = options.shouldIgnoreUrl ?? shouldIgnoreFromConfig;
    if (shouldIgnore(url)) return;

    if (SoftprobeContext.getMode() === 'CAPTURE' && options.bypassFetch) {
      await handleCaptureRequest(request, controller, options.bypassFetch);
      return;
    }

    /** Task 18.2.2: use active context mode to decide MOCK vs PASSTHROUGH; only run matcher when REPLAY. */
    if (SoftprobeContext.getMode() !== 'REPLAY') return;

    const method = (request.method ?? 'GET').toUpperCase();
    const identifier = httpIdentifier(method, url);
    HttpSpan.tagRequest(method, url, undefined, trace.getActiveSpan() ?? undefined);

    const matcher = SoftprobeContext.active().matcher as {
      match?: (spanOverride?: { attributes?: Record<string, unknown> }) => MatcherAction;
    } | undefined;
    const match = matcher?.match?.bind(matcher);
    if (!match) {
      throw new Error('Softprobe replay matcher is required in REPLAY mode');
    }
    const result = match({
      attributes: {
        'softprobe.protocol': 'http',
        'softprobe.identifier': identifier,
      },
    });

    if (result.action === 'MOCK') {
      const payload = (result.payload ?? {}) as {
        body?: unknown;
        status?: number;
        statusCode?: number;
        headers?: Record<string, string>;
      };

      controller.respondWith(
        new Response(toTextBody(payload.body), {
          status: payload.status ?? payload.statusCode ?? 200,
          headers: payload.headers,
        })
      );
      return;
    }

    if (result.action === 'PASSTHROUGH') return;

    if (SoftprobeContext.getStrictReplay()) {
      controller.respondWith(
        jsonErrorResponse('[Softprobe] No recorded traces found for http request')
      );
    }
    // CONTINUE + DEV: leave request untouched (passthrough)
  } catch (err) {
    const details = err instanceof Error ? err.message : String(err);
    event.controller.respondWith(jsonErrorResponse('Softprobe Replay Error', details));
  }
}

function getBypassFetch(): HttpReplayOptions['bypassFetch'] {
  try {
    const undici = require('undici');
    if (typeof undici.fetch === 'function') return undici.fetch as HttpReplayOptions['bypassFetch'];
  } catch {
    /* undici not available */
  }
  return globalThis.fetch;
}

export function setupHttpReplayInterceptor(options: HttpReplayOptions = {}) {
  const bypassFetch = options.bypassFetch ?? getBypassFetch();
  const interceptor = new BatchInterceptor({
    name: 'softprobe-http-replay',
    interceptors: [new ClientRequestInterceptor(), new FetchInterceptor()],
  });

  interceptor.on('request', ({ request, controller }) => {
    void handleHttpReplayRequest(
      { request, controller },
      { ...options, bypassFetch: options.bypassFetch ?? bypassFetch }
    );
  });

  // REPLAY: do not apply MSW; re-apply undici fetch as global so replay returns exact recorded response (Node 18+ uses undici).
  if (SoftprobeContext.getMode() === 'REPLAY') {
    setCaptureUsesInterceptor(true);
    applyUndiciFetchAsGlobal();
    return interceptor;
  }

  setCaptureUsesInterceptor(true);
  interceptor.apply();
  return interceptor;
}
