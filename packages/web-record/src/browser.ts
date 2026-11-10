import { RecordSdk } from "./sdk.js";
import type { WebRecordController, WebRecordInitOptions } from "./types.js";

declare global {
  interface Window {
    RecordSdk?: typeof RecordSdk;
    Softprobe?: {
      RecordSdk: typeof RecordSdk;
    };
    __softprobeSession?: WebRecordController;
  }
}

export function autoInitFromScript(
  doc: Document | undefined = typeof document !== "undefined" ? document : undefined,
): WebRecordController | undefined {
  if (!doc) return undefined;
  const current = doc.currentScript instanceof HTMLScriptElement ? doc.currentScript : null;
  const script =
    current ??
    doc.querySelector<HTMLScriptElement>(
      "script[data-api-key], script[data-softprobe-api-key], script[data-softprobe-options]",
    );
  if (!script) return undefined;

  const rawOptions = script.dataset.softprobeOptions?.trim();
  if (rawOptions) {
    const parsed = JSON.parse(rawOptions) as WebRecordInitOptions;
    const session = RecordSdk.init(parsed);
    if (typeof window !== "undefined") {
      window.__softprobeSession = session;
    }
    return session;
  }

  const apiKey = (script.dataset.apiKey ?? script.dataset.softprobeApiKey)?.trim();
  if (!apiKey) return undefined;

  const options: WebRecordInitOptions = {
    apiKey,
    ...(script.dataset.baseUrl?.trim() ? { baseUrl: script.dataset.baseUrl.trim() } : {}),
    ...(script.dataset.serviceName?.trim() ? { serviceName: script.dataset.serviceName.trim() } : {}),
    ...(script.dataset.environment?.trim() ? { environment: script.dataset.environment.trim() } : {}),
  };

  const session = RecordSdk.init(options);
  if (typeof window !== "undefined") {
    window.__softprobeSession = session;
  }
  return session;
}

if (typeof window !== "undefined") {
  window.RecordSdk = RecordSdk;
  window.Softprobe = { RecordSdk };
  autoInitFromScript();
}

export { RecordSdk };
