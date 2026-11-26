import { Resource } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { instrumentReactNativeFetch } from "./fetch-instrumentation.js";
import { instrumentReactNativeXhr } from "./xhr-instrumentation.js";
import {
  FetchOtlpJsonSpanExporter,
  resolveMobileSessionId,
  resolveOtlpTracesUrl,
  SoftprobeMobileSpanProcessor,
} from "./span-processor.js";
import {
  parseMobileSessionId,
  type InitSoftprobeReactNativeOptions,
  type InstallSoftprobeReactNativeOptions,
  type MobileSessionId,
  type SoftprobeReactNativeHandle,
} from "./types.js";
import { createReactNativeActionRecorder } from "./ui-instrumentation.js";

const TRACER_SCOPE_NAME = "@softprobe/react-native";
const TRACER_SCOPE_VERSION = "0.2.8";

export function installSoftprobeReactNative(
  options: InstallSoftprobeReactNativeOptions,
): SoftprobeReactNativeHandle {
  const ownedProcessor =
    options.spanProcessor ??
    new SoftprobeMobileSpanProcessor({
      platform: options.platform,
      serviceName: options.serviceName,
      sessionId: options.sessionId,
      launchArguments: options.launchArguments,
      resourceAttributes: options.resourceAttributes,
    });

  if (!options.spanProcessor) {
    if (typeof options.tracerProvider.addSpanProcessor !== "function") {
      throw new Error(
        "TracerProvider does not expose `addSpanProcessor`. Construct `SoftprobeMobileSpanProcessor` in `spanProcessors` and pass it via `spanProcessor`.",
      );
    }
    options.tracerProvider.addSpanProcessor(ownedProcessor);
  }

  let fallbackSessionId: MobileSessionId = resolveMobileSessionId({
    sessionId: options.sessionId,
    launchArguments: options.launchArguments,
  });

  const getSessionId = (): MobileSessionId => {
    const candidate =
      "getSessionId" in ownedProcessor && typeof ownedProcessor.getSessionId === "function"
        ? parseMobileSessionId(ownedProcessor.getSessionId())
        : undefined;
    return candidate ?? fallbackSessionId;
  };

  const setSessionId = (nextSessionId: string): MobileSessionId => {
    const parsed = parseMobileSessionId(nextSessionId);
    if (!parsed) {
      throw new Error(
        "Invalid Softprobe sessionId: expected 1..128 printable ASCII characters",
      );
    }
    fallbackSessionId = parsed;
    if ("setSessionId" in ownedProcessor && typeof ownedProcessor.setSessionId === "function") {
      ownedProcessor.setSessionId(parsed);
    }
    return parsed;
  };

  const tracer = options.tracerProvider.getTracer(
    TRACER_SCOPE_NAME,
    TRACER_SCOPE_VERSION,
  );

  const actions = createReactNativeActionRecorder({
    tracer,
    platform: options.platform,
    initialRoute: options.initialRoute,
    viewport: options.viewport,
    getViewport: options.getViewport,
    observeAnchors: options.observeAnchors,
    inputCapture: options.inputCapture,
    secretSlots: options.secretSlots,
    quietMs: options.quietMs,
    maxSettleMs: options.maxSettleMs,
  });

  const shouldPatchGlobal = options.instrumentGlobalFetch ?? true;
  const fetchHandle = instrumentReactNativeFetch({
    tracer,
    getSessionId,
    apiOrigins: options.apiOrigins,
    baseOrigin: options.baseOrigin,
    ignoreUrls: options.ignoreUrls,
    httpBodyCapture: options.httpBodyCapture,
    redactJsonPaths: options.redactJsonPaths,
    actionRecorder: actions,
    fetchImpl: options.fetchImpl,
    target: shouldPatchGlobal ? options.fetchTarget : { fetch: options.fetchImpl ?? fetch },
  });

  const shouldPatchXhr = options.instrumentGlobalXhr ?? true;
  const xhrHandle = shouldPatchXhr
    ? instrumentReactNativeXhr({
        tracer,
        getSessionId,
        apiOrigins: options.apiOrigins,
        baseOrigin: options.baseOrigin,
        ignoreUrls: options.ignoreUrls,
        httpBodyCapture: options.httpBodyCapture,
        redactJsonPaths: options.redactJsonPaths,
        actionRecorder: actions,
        target: options.xhrTarget,
      })
    : undefined;

  let uninstalled = false;

  return {
    get sessionId(): MobileSessionId {
      return getSessionId();
    },
    platform: options.platform,
    tracerProvider: options.tracerProvider,
    tracer,
    spanProcessor: ownedProcessor,
    actions,
    fetch: fetchHandle.fetch,
    getSessionId,
    setSessionId,
    async flush(): Promise<void> {
      actions.flush();
      await ownedProcessor.forceFlush();
      await options.tracerProvider.forceFlush?.();
    },
    async shutdown(): Promise<void> {
      actions.shutdown();
      fetchHandle.uninstall();
      xhrHandle?.uninstall();
      uninstalled = true;
      await ownedProcessor.shutdown();
      await options.tracerProvider.shutdown?.();
    },
    uninstall(): void {
      if (uninstalled) return;
      uninstalled = true;
      actions.shutdown();
      fetchHandle.uninstall();
      xhrHandle?.uninstall();
    },
  };
}

export function initSoftprobeReactNative(
  options: InitSoftprobeReactNativeOptions,
): SoftprobeReactNativeHandle {
  if (options.tracerProvider) {
    return installSoftprobeReactNative({
      ...options,
      tracerProvider: options.tracerProvider,
    });
  }

  const tracesUrl = resolveOtlpTracesUrl({
    tracesEndpoint: options.tracesEndpoint,
    endpoint: options.endpoint,
  });

  const spanProcessor = new SoftprobeMobileSpanProcessor({
    platform: options.platform,
    serviceName: options.serviceName,
    sessionId: options.sessionId,
    launchArguments: options.launchArguments,
    resourceAttributes: options.resourceAttributes,
  });

  const exporter = new FetchOtlpJsonSpanExporter({
    tracesEndpoint: tracesUrl,
    ingestionKey: options.ingestionKey,
    headers: options.headers,
    timeoutMillis: options.exportTimeoutMillis,
    fetchImpl: options.fetchImpl,
    serviceName: options.serviceName,
    resourceAttributes: options.resourceAttributes,
  });

  const exportProcessor = options.batchExport
    ? new BatchSpanProcessor(exporter)
    : new SimpleSpanProcessor(exporter);

  const resource = new Resource({
    ...(options.serviceName?.trim()
      ? { "service.name": options.serviceName.trim() }
      : {}),
    "sp.platform": options.platform,
    ...(options.resourceAttributes ?? {}),
  });

  const provider = new BasicTracerProvider({
    resource,
    spanProcessors: [spanProcessor, exportProcessor],
  });

  if (options.registerGlobalTracerProvider) {
    provider.register();
  }

  return installSoftprobeReactNative({
    ...options,
    tracerProvider: provider,
    spanProcessor,
    ignoreUrls: [...(options.ignoreUrls ?? []), tracesUrl],
  });
}

export {
  extractLaunchArgumentSessionId,
  FetchOtlpJsonSpanExporter,
  generateDefaultMobileSessionId,
  resolveMobileSessionId,
  resolveOtlpTracesUrl,
  serializeReadableSpansToOtlpJson,
  SoftprobeMobileSpanProcessor,
  type OtlpJsonAnyValue,
  type OtlpJsonExportPayload,
  type OtlpJsonKeyValue,
} from "./span-processor.js";
export { instrumentReactNativeFetch } from "./fetch-instrumentation.js";
export { instrumentReactNativeXhr } from "./xhr-instrumentation.js";
export {
  createNavigationStateChangeHandler,
  createReactNativeActionRecorder,
  createResponderProps,
  formatMobileActionSummary,
  getActiveRouteNameFromState,
  wrapTextInputHandlers,
} from "./ui-instrumentation.js";
export {
  BAGGAGE_SESSION_KEY,
  isMobileSessionId,
  parseMobileSessionId,
  UI_ACTION_SCHEMA_VERSION,
  type ActionAnchorOptions,
  type CapturedInputValue,
  type CausedHttpTrace,
  type FetchOtlpJsonSpanExporterOptions,
  type HttpBodyCaptureOptions,
  type HttpBodyCaptureRoute,
  type HttpLifecycleObserver,
  type HttpSpanEndNotification,
  type HttpSpanStartNotification,
  type InitSoftprobeReactNativeOptions,
  type InputCaptureMode,
  type InstallSoftprobeReactNativeOptions,
  type InstrumentedFetchHandle,
  type InstrumentedXhrHandle,
  type InstrumentReactNativeFetchOptions,
  type InstrumentReactNativeXhrOptions,
  type LaunchArgumentsInput,
  type MobilePlatform,
  type MobileSessionId,
  type MutableTracerProvider,
  type NavigationRouteChangeOptions,
  type ReactNativeActionRecorder,
  type ReactNativeActionRecorderOptions,
  type ReactNativeResponderProps,
  type ReactNavigationRouteLike,
  type ReactNavigationStateLike,
  type RecordedSemanticAction,
  type RecordFillOptions,
  type RecordLongPressOptions,
  type RecordTapOptions,
  type ResponderPropsOptions,
  type ResponderTouchEventLike,
  type SemanticAnchorState,
  type SemanticModifierKey,
  type SemanticTarget,
  type SemanticVerb,
  type SoftprobeMobileSpanProcessorOptions,
  type SoftprobeReactNativeHandle,
  type TextInputChangeEventLike,
  type TextInputHandlersLike,
  type WrappedTextInputHandlers,
  type XmlHttpRequestConstructorLike,
  type XmlHttpRequestLike,
} from "./types.js";
