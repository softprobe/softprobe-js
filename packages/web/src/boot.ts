import {
  RecordSdk,
  type HttpBodyCaptureOptions,
  type WebRecordController,
} from "@softprobe/web-record";

const SESSION_KEY = "x-sp-session-id";
const BOOTED = "__softprobeSession";

export type ScriptConfig = {
  apiKey: string;
  baseUrl: string;
  apiOrigins: string[];
  environment?: string;
  serviceName: string;
  maskAllInputs: boolean;
  maskTextSelector?: string;
  blockSelector?: string;
  httpBodyCapture?: HttpBodyCaptureOptions;
};

type BootWindow = Window & {
  [BOOTED]?: WebRecordController;
};

export function readScriptConfig(
  script: HTMLScriptElement | null,
): ScriptConfig | null {
  if (!script) return null;
  const baseUrl = script.dataset.baseUrl?.trim() ?? "";
  const apiKey = script.dataset.apiKey?.trim()
    || script.dataset.publicKey?.trim()
    || "";
  // Agent keys identify the owning App. Keep the deprecated public-key path
  // working for existing installations.
  if (!baseUrl || !apiKey) return null;
  const apiOrigins = [...new Set(
    (script.dataset.apiOrigins ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  )];
  const maskTextSelector = script.dataset.maskTextSelector?.trim() || undefined;
  const blockSelector = script.dataset.blockSelector?.trim() || undefined;
  let httpBodyCapture: HttpBodyCaptureOptions | undefined;
  try {
    const rawCapture = script.dataset.httpBodyCapture?.trim();
    const parsedCapture: unknown = rawCapture ? JSON.parse(rawCapture) : undefined;
    if (parsedCapture && typeof parsedCapture === "object" && Array.isArray((parsedCapture as { routes?: unknown }).routes)) {
      httpBodyCapture = parsedCapture as HttpBodyCaptureOptions;
    }
  } catch {
    httpBodyCapture = undefined;
  }
  return {
    apiKey,
    baseUrl,
    apiOrigins,
    environment: script.dataset.environment?.trim() || undefined,
    serviceName: script.dataset.serviceName?.trim() || "softprobe-web",
    maskAllInputs: script.dataset.maskAllInputs?.toLowerCase() !== "false",
    maskTextSelector,
    blockSelector,
    ...(httpBodyCapture ? { httpBodyCapture } : {}),
  };
}

/** Reuse the page's session id, or create one and keep it for later navigations. */
export function readOrCreateSessionId(storage: Storage): string {
  const existing = storage.getItem(SESSION_KEY)?.trim();
  if (existing) return existing;
  const id = `sp-session-${newUuid()}`;
  storage.setItem(SESSION_KEY, id);
  return id;
}

/**
 * `crypto.randomUUID` exists only in a secure context. The demo is served over
 * plain HTTP, where that call throws and the script never starts recording.
 * `getRandomValues` works there.
 */
function newUuid(): string {
  try {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    // Insecure context: fall through.
  }
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => {
    const n = Number(c);
    const byte = crypto.getRandomValues(new Uint8Array(1))[0] ?? 0;
    return (n ^ (byte & (15 >> (n / 4)))).toString(16);
  });
}

/**
 * Start recording and browser request tracing from the current script tag.
 * A second call on the same page does nothing.
 */
export function boot(
  script: HTMLScriptElement | null = currentScript(),
): WebRecordController | null {
  if (typeof window === "undefined") return null;
  const host = window as BootWindow;
  if (host[BOOTED]) return host[BOOTED];

  const config = readScriptConfig(script);
  if (!config) {
    console.warn(
      "[@softprobe/web] data-base-url and data-api-key are required; session script disabled.",
    );
    return null;
  }

  const recorder = RecordSdk.init({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    apiOrigins: config.apiOrigins,
    environment: config.environment,
    serviceName: config.serviceName,
    maskAllInputs: config.maskAllInputs,
    maskTextSelector: config.maskTextSelector,
    blockSelector: config.blockSelector,
    httpBodyCapture: config.httpBodyCapture,
    sessionId: readOrCreateSessionId(window.sessionStorage),
    onUploadStatus: (status) => {
      document.documentElement.dataset.softprobeCaptureStatus = status;
    },
  });
  host[BOOTED] = recorder;
  return recorder;
}

function currentScript(): HTMLScriptElement | null {
  const current = document.currentScript;
  return current instanceof HTMLScriptElement ? current : null;
}
