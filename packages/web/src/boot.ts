import { RecordSdk, type WebRecordController } from "@softprobe/web-record";

const SESSION_KEY = "x-sp-session-id";
const BOOTED = "__softprobeSession";

export type ScriptConfig = {
  baseUrl: string;
  publicKey: string;
};

type BootWindow = Window & {
  [BOOTED]?: WebRecordController;
};

export function readScriptConfig(
  script: HTMLScriptElement | null,
): ScriptConfig | null {
  if (!script) return null;
  const baseUrl = script.dataset.baseUrl?.trim() ?? "";
  const publicKey = script.dataset.publicKey?.trim() ?? "";
  if (!baseUrl || !publicKey) return null;
  return { baseUrl, publicKey };
}

/** Reuse the page's session id, or create one and keep it for later navigations. */
export function readOrCreateSessionId(storage: Storage): string {
  const existing = storage.getItem(SESSION_KEY)?.trim();
  if (existing) return existing;
  const id = `sp-session-${crypto.randomUUID()}`;
  storage.setItem(SESSION_KEY, id);
  return id;
}

/**
 * Start recording and same-origin session headers from the current script tag.
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
      "[@softprobe/web] data-base-url and data-public-key are required; session script disabled.",
    );
    return null;
  }

  const recorder = RecordSdk.init({
    publicKey: config.publicKey,
    baseUrl: config.baseUrl,
    sessionId: readOrCreateSessionId(window.sessionStorage),
    serviceName: "softprobe-web",
  });
  host[BOOTED] = recorder;
  window.addEventListener("pagehide", () => {
    recorder.stop();
  });
  return recorder;
}

function currentScript(): HTMLScriptElement | null {
  const current = document.currentScript;
  return current instanceof HTMLScriptElement ? current : null;
}
