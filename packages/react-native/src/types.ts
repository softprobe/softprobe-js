import type { Tracer, TracerProvider } from "@opentelemetry/api";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";

export const UI_ACTION_SCHEMA_VERSION = "sp-ui-action-1" as const;
export const BAGGAGE_SESSION_KEY = "sp.session.id" as const;

export type MobilePlatform = "ios" | "android";

export type MobileSessionId = string & { readonly __brand: "MobileSessionId" };

const SESSION_ID_ASCII_RE = /^[!-~]{1,128}$/;

export function isMobileSessionId(value: unknown): value is MobileSessionId {
  return typeof value === "string" && SESSION_ID_ASCII_RE.test(value);
}

export function parseMobileSessionId(value: unknown): MobileSessionId | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return isMobileSessionId(trimmed) ? trimmed : undefined;
}

export type LaunchArgumentsInput =
  | Readonly<Record<string, unknown>>
  | readonly string[];

export type InputCaptureMode = "masked" | "secrets-only" | "unmasked";

export type CapturedInputValue =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "secret"; readonly slot: string }
  | { readonly kind: "redacted"; readonly length: number };

export type SemanticAnchorState = "checked" | "expanded" | "pressed" | "selected";

export type SemanticModifierKey = "Alt" | "Control" | "Meta" | "Shift";

export interface SemanticTarget {
  readonly testId?: string;
  readonly accessibilityId?: string;
  readonly role?: string;
  readonly name?: string;
  readonly label?: string;
  readonly nearbyLabel?: string;
  readonly interactive?: boolean;
  readonly placeholder?: string;
  readonly text?: string;
  readonly inputPurpose?: string;
  readonly cssSelector?: string;
  readonly within?: string;
  readonly position?: { readonly index: number; readonly of: number };
  readonly rect?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly pointOffset?: { readonly fx: number; readonly fy: number };
  readonly framePath?: readonly string[];
  readonly rrwebNodeId?: number;
  readonly states?: readonly SemanticAnchorState[];
  readonly value?: string;
}

export interface CausedHttpTrace {
  readonly traceId: string;
  readonly spanId?: string;
  readonly method: string;
  readonly url: string;
  readonly urlTemplate?: string;
  readonly status?: number;
}

export type SemanticVerb =
  | {
      readonly name: "navigate";
      readonly url: string;
      readonly trigger: "load" | "pushState" | "popstate";
    }
  | {
      readonly name: "click" | "dblclick" | "contextmenu" | "hover";
      readonly target: SemanticTarget;
      readonly modifiers?: readonly SemanticModifierKey[];
      readonly point: { readonly x: number; readonly y: number };
    }
  | {
      readonly name: "fill";
      readonly target: SemanticTarget;
      readonly value: CapturedInputValue;
      readonly replace: boolean;
    }
  | {
      readonly name: "select";
      readonly target: SemanticTarget;
      readonly value: CapturedInputValue;
      readonly optionLabel?: string;
    }
  | {
      readonly name: "check";
      readonly target: SemanticTarget;
      readonly checked: boolean;
    }
  | {
      readonly name: "press";
      readonly target?: SemanticTarget;
      readonly key: string;
      readonly modifiers?: readonly SemanticModifierKey[];
    }
  | {
      readonly name: "upload";
      readonly target: SemanticTarget;
      readonly fileNames: readonly string[];
      readonly mimeTypes: readonly string[];
    }
  | {
      readonly name: "drag";
      readonly source: SemanticTarget;
      readonly destination: SemanticTarget;
    }
  | {
      readonly name: "scroll";
      readonly target?: SemanticTarget;
      readonly direction: "up" | "down" | "left" | "right";
      readonly times: number;
      readonly spansViewport: number;
    }
  | {
      readonly name: "dialog";
      readonly dialogType: "alert" | "confirm" | "prompt" | "beforeunload";
      readonly accepted: boolean;
      readonly promptText?: CapturedInputValue;
    }
  | {
      readonly name: "resize";
      readonly viewport: { readonly width: number; readonly height: number };
    }
  | { readonly name: "back" }
  | { readonly name: "dismissKeyboard" }
  | { readonly name: "openLink"; readonly url: string }
  | {
      readonly name: "swipe";
      readonly direction: "up" | "down" | "left" | "right";
      readonly target?: SemanticTarget;
      readonly distanceRatio?: number;
    }
  | {
      readonly name: "longPress";
      readonly target: SemanticTarget;
      readonly point?: { readonly x: number; readonly y: number };
      readonly durationMs?: number;
    };

export interface RecordedSemanticAction {
  readonly schemaVersion: "sp-ui-action-1";
  readonly actionIndex: number;
  readonly timestampMs: number;
  readonly startPath: string;
  readonly endPath: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly verb: SemanticVerb;
  readonly causedTraces: readonly CausedHttpTrace[];
  readonly endAnchors: readonly SemanticTarget[];
  readonly goneAnchors: readonly SemanticTarget[];
  readonly settleMs: number;
  readonly platform?: "web" | "ios" | "android";
  readonly captureSource?: "web_sdk" | "host_agent" | "otel_sdk";
}

export interface HttpBodyCaptureRoute {
  readonly origin?: string;
  readonly method: string;
  readonly path: string;
  readonly redactJsonPaths?: readonly string[];
}

export interface HttpBodyCaptureOptions {
  readonly maxBodyBytes?: number;
  readonly routes?: readonly HttpBodyCaptureRoute[];
  readonly redactJsonPaths?: readonly string[];
}

export interface HttpSpanStartNotification {
  readonly traceId: string;
  readonly spanId: string;
  readonly method: string;
  readonly url: string;
  readonly urlTemplate?: string;
}

export interface HttpSpanEndNotification {
  readonly traceId: string;
  readonly spanId: string;
  readonly method: string;
  readonly url: string;
  readonly urlTemplate?: string;
  readonly status?: number;
}

export interface HttpLifecycleObserver {
  onHttpSpanStart(info: HttpSpanStartNotification): void;
  onHttpSpanEnd(info: HttpSpanEndNotification): void;
}

export interface ActionAnchorOptions {
  readonly endAnchors?: readonly SemanticTarget[];
  readonly goneAnchors?: readonly SemanticTarget[];
}

export interface RecordTapOptions extends ActionAnchorOptions {
  readonly point?: { readonly x: number; readonly y: number };
  readonly modifiers?: readonly SemanticModifierKey[];
}

export interface RecordLongPressOptions extends ActionAnchorOptions {
  readonly point?: { readonly x: number; readonly y: number };
  readonly durationMs?: number;
}

export interface RecordFillOptions extends ActionAnchorOptions {
  readonly secureTextEntry?: boolean;
  readonly secretSlot?: string;
  readonly replace?: boolean;
}

export interface NavigationRouteChangeOptions extends ActionAnchorOptions {
  readonly trigger?: "load" | "pushState" | "popstate" | "back" | "openLink";
  readonly params?: Readonly<Record<string, unknown>>;
}

export interface SoftprobeMobileSpanProcessorOptions {
  readonly platform: MobilePlatform;
  readonly serviceName?: string;
  readonly sessionId?: string;
  readonly launchArguments?: LaunchArgumentsInput;
  readonly resourceAttributes?: Readonly<Record<string, string | number | boolean>>;
  readonly generateSessionId?: () => string;
}

export interface FetchOtlpJsonSpanExporterOptions {
  readonly endpoint?: string;
  readonly tracesEndpoint?: string;
  readonly ingestionKey?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMillis?: number;
  readonly fetchImpl?: typeof fetch;
  readonly serviceName?: string;
  readonly resourceAttributes?: Readonly<Record<string, string | number | boolean>>;
}

export interface InstrumentReactNativeFetchOptions {
  readonly tracer: Tracer | (() => Tracer);
  readonly getSessionId: () => string | undefined;
  readonly apiOrigins?: readonly string[];
  readonly baseOrigin?: string;
  readonly ignoreUrls?: readonly (string | RegExp)[];
  readonly httpBodyCapture?: boolean | HttpBodyCaptureOptions;
  readonly redactJsonPaths?: readonly string[];
  readonly actionRecorder?: HttpLifecycleObserver;
  readonly fetchImpl?: typeof fetch;
  readonly target?: { fetch: typeof fetch };
}

export interface InstrumentedFetchHandle {
  readonly fetch: typeof fetch;
  uninstall(): void;
}

export interface XmlHttpRequestLike {
  open(method: string, url: string, async?: boolean, user?: string | null, password?: string | null): void;
  setRequestHeader(name: string, value: string): void;
  send(body?: unknown): void;
  status?: number;
  response?: unknown;
  responseText?: string;
  getResponseHeader?: (name: string) => string | null;
  getAllResponseHeaders?: () => string;
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
  onreadystatechange?: (() => void) | null;
  readyState?: number;
}

export interface XmlHttpRequestConstructorLike {
  readonly prototype: XmlHttpRequestLike;
}

export interface InstrumentReactNativeXhrOptions {
  readonly tracer: Tracer | (() => Tracer);
  readonly getSessionId: () => string | undefined;
  readonly apiOrigins?: readonly string[];
  readonly baseOrigin?: string;
  readonly ignoreUrls?: readonly (string | RegExp)[];
  readonly httpBodyCapture?: boolean | HttpBodyCaptureOptions;
  readonly redactJsonPaths?: readonly string[];
  readonly actionRecorder?: HttpLifecycleObserver;
  readonly xhrConstructor?: XmlHttpRequestConstructorLike;
  readonly target?: { XMLHttpRequest?: XmlHttpRequestConstructorLike };
}

export interface InstrumentedXhrHandle {
  uninstall(): void;
}

export interface ReactNavigationRouteLike {
  readonly name?: string;
  readonly path?: string;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly state?: ReactNavigationStateLike;
}

export interface ReactNavigationStateLike {
  readonly index?: number;
  readonly routes?: readonly ReactNavigationRouteLike[];
}

export interface ResponderTouchEventLike {
  readonly nativeEvent?: {
    readonly locationX?: number;
    readonly locationY?: number;
    readonly pageX?: number;
    readonly pageY?: number;
  };
}

export interface ResponderPropsOptions extends RecordTapOptions {
  readonly shouldSetResponder?: boolean;
  readonly onStartShouldSetResponder?: (event: ResponderTouchEventLike) => boolean;
  readonly onResponderRelease?: (event: ResponderTouchEventLike) => void;
}

export interface ReactNativeResponderProps {
  readonly onStartShouldSetResponder: (event: ResponderTouchEventLike) => boolean;
  readonly onResponderRelease: (event: ResponderTouchEventLike) => void;
}

export interface TextInputChangeEventLike {
  readonly nativeEvent?: {
    readonly text?: string;
  };
}

export interface TextInputHandlersLike<TEvent = TextInputChangeEventLike> {
  readonly onChangeText?: (text: string) => void;
  readonly onEndEditing?: (event: TEvent) => void;
  readonly onSubmitEditing?: (event: TEvent) => void;
  readonly onBlur?: (event: TEvent) => void;
  readonly secureTextEntry?: boolean;
  readonly secretSlot?: string;
  readonly replace?: boolean;
  readonly commitOnChange?: boolean;
  readonly endAnchors?: readonly SemanticTarget[];
  readonly goneAnchors?: readonly SemanticTarget[];
}

export interface WrappedTextInputHandlers<TEvent = TextInputChangeEventLike> {
  readonly onChangeText: (text: string) => void;
  readonly onEndEditing: (event: TEvent) => void;
  readonly onSubmitEditing: (event: TEvent) => void;
  readonly onBlur: (event: TEvent) => void;
}

export interface ReactNativeActionRecorderOptions {
  readonly tracer: Tracer | (() => Tracer | undefined);
  readonly platform: MobilePlatform;
  readonly initialRoute?: string;
  readonly viewport?: { readonly width: number; readonly height: number };
  readonly getViewport?: () => { readonly width: number; readonly height: number };
  readonly observeAnchors?: () => readonly SemanticTarget[];
  readonly inputCapture?: InputCaptureMode;
  readonly secretSlots?: Readonly<Record<string, string>>;
  readonly quietMs?: number;
  readonly maxSettleMs?: number;
  readonly now?: () => number;
}

export interface ReactNativeActionRecorder extends HttpLifecycleObserver {
  readonly currentPath: string;
  onNavigationRouteChange(
    routeNameOrPath: string,
    paramsOrOptions?: NavigationRouteChangeOptions | Readonly<Record<string, unknown>>,
  ): void;
  recordTap(
    target: SemanticTarget,
    pointOrOptions?: { readonly x: number; readonly y: number } | RecordTapOptions,
  ): void;
  recordLongPress(target: SemanticTarget, options?: RecordLongPressOptions): void;
  recordSwipe(
    direction: "up" | "down" | "left" | "right",
    target?: SemanticTarget,
    distanceRatio?: number,
    options?: ActionAnchorOptions,
  ): void;
  recordBack(options?: { readonly toRoute?: string } & ActionAnchorOptions): void;
  recordDismissKeyboard(options?: ActionAnchorOptions): void;
  recordFill(
    target: SemanticTarget,
    rawValue: string,
    options?: RecordFillOptions,
  ): void;
  recordEndAnchors(anchors: readonly SemanticTarget[]): void;
  recordGoneAnchors(anchors: readonly SemanticTarget[]): void;
  hasPendingWork(): boolean;
  flush(): void;
  waitForIdle(): Promise<void>;
  shutdown(): void;
}

export interface MutableTracerProvider extends TracerProvider {
  addSpanProcessor?: (spanProcessor: SpanProcessor) => void;
  forceFlush?: () => Promise<void>;
  shutdown?: () => Promise<void>;
}

export interface InstallSoftprobeReactNativeOptions {
  readonly tracerProvider: MutableTracerProvider;
  readonly spanProcessor?: SpanProcessor & {
    getSessionId?: () => string;
    setSessionId?: (sessionId: string) => string;
  };
  readonly platform: MobilePlatform;
  readonly serviceName?: string;
  readonly sessionId?: string;
  readonly launchArguments?: LaunchArgumentsInput;
  readonly resourceAttributes?: Readonly<Record<string, string | number | boolean>>;
  readonly apiOrigins?: readonly string[];
  readonly baseOrigin?: string;
  readonly ignoreUrls?: readonly (string | RegExp)[];
  readonly httpBodyCapture?: boolean | HttpBodyCaptureOptions;
  readonly redactJsonPaths?: readonly string[];
  readonly initialRoute?: string;
  readonly viewport?: { readonly width: number; readonly height: number };
  readonly getViewport?: () => { readonly width: number; readonly height: number };
  readonly observeAnchors?: () => readonly SemanticTarget[];
  readonly inputCapture?: InputCaptureMode;
  readonly secretSlots?: Readonly<Record<string, string>>;
  readonly quietMs?: number;
  readonly maxSettleMs?: number;
  readonly instrumentGlobalFetch?: boolean;
  readonly instrumentGlobalXhr?: boolean;
  readonly fetchImpl?: typeof fetch;
  readonly fetchTarget?: { fetch: typeof fetch };
  readonly xhrTarget?: { XMLHttpRequest?: XmlHttpRequestConstructorLike };
}

export interface InitSoftprobeReactNativeOptions
  extends Omit<InstallSoftprobeReactNativeOptions, "tracerProvider"> {
  readonly tracerProvider?: MutableTracerProvider;
  readonly endpoint?: string;
  readonly tracesEndpoint?: string;
  readonly ingestionKey?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly exportTimeoutMillis?: number;
  readonly batchExport?: boolean;
  readonly registerGlobalTracerProvider?: boolean;
}

export interface SoftprobeReactNativeHandle {
  readonly sessionId: MobileSessionId;
  readonly platform: MobilePlatform;
  readonly tracerProvider: MutableTracerProvider;
  readonly tracer: Tracer;
  readonly spanProcessor: SpanProcessor;
  readonly actions: ReactNativeActionRecorder;
  readonly fetch: typeof fetch;
  getSessionId(): MobileSessionId;
  setSessionId(sessionId: string): MobileSessionId;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
  uninstall(): void;
}
