import { BatchInterceptor } from '@mswjs/interceptors';
import { ClientRequestInterceptor } from '@mswjs/interceptors/ClientRequest';
import { FetchInterceptor } from '@mswjs/interceptors/fetch';
import { softprobe } from '../api';
import { ConfigManager } from '../config/config-manager';
import type { MatcherAction } from '../types/schema';

type RequestController = { respondWith: (response: Response) => void };
type RequestEvent = { request: Request; controller: RequestController };

type HttpReplayOptions = {
  shouldIgnoreUrl?: (url?: string) => boolean;
  match?: () => MatcherAction;
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

function toTextBody(body: unknown): string {
  if (typeof body === 'string') return body;
  if (body == null) return '';
  return JSON.stringify(body);
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

    const match = options.match ?? (() => {
      const matcher = softprobe.getActiveMatcher() as { match?: () => MatcherAction } | undefined;
      return matcher?.match ? matcher.match() : { action: 'CONTINUE' as const };
    });

    const result = match();

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

    if (process.env.SOFTPROBE_STRICT_REPLAY === '1') {
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

export function setupHttpReplayInterceptor(options: HttpReplayOptions = {}) {
  const interceptor = new BatchInterceptor({
    name: 'softprobe-http-replay',
    interceptors: [new ClientRequestInterceptor(), new FetchInterceptor()],
  });

  interceptor.on('request', ({ request, controller }) => {
    void handleHttpReplayRequest({ request, controller }, options);
  });

  interceptor.apply();
  return interceptor;
}
