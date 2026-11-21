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
      "script[data-ingestion-key], script[data-softprobe-options]",
    );
  if (!script) return undefined;

  const captureSemanticRaw = script.dataset.captureSemanticActions?.trim().toLowerCase();
  const captureSemanticActions =
    captureSemanticRaw === "true" || captureSemanticRaw === "1"
      ? true
      : captureSemanticRaw === "false" || captureSemanticRaw === "0"
        ? false
        : undefined;
  const inputCaptureRaw = script.dataset.inputCapture?.trim();
  const inputCapture =
    inputCaptureRaw === "masked" ||
    inputCaptureRaw === "secrets-only" ||
    inputCaptureRaw === "unmasked"
      ? inputCaptureRaw
      : undefined;

  const rawOptions = script.dataset.softprobeOptions?.trim();
  if (rawOptions) {
    const parsed = JSON.parse(rawOptions) as WebRecordInitOptions;
    const merged: WebRecordInitOptions = {
      ...(captureSemanticActions !== undefined ? { captureSemanticActions } : {}),
      ...(inputCapture !== undefined ? { inputCapture } : {}),
      ...parsed,
    };
    const session = RecordSdk.init(merged);
    if (typeof window !== "undefined") {
      window.__softprobeSession = session;
    }
    return session;
  }

  const ingestionKey = script.dataset.ingestionKey?.trim();
  if (!ingestionKey) return undefined;

  const options: WebRecordInitOptions = {
    ingestionKey,
    ...(script.dataset.serviceName?.trim() ? { serviceName: script.dataset.serviceName.trim() } : {}),
    ...(script.dataset.environment?.trim() ? { environment: script.dataset.environment.trim() } : {}),
    ...(captureSemanticActions !== undefined ? { captureSemanticActions } : {}),
    ...(inputCapture !== undefined ? { inputCapture } : {}),
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
