import { SpanStatusCode, type Tracer } from "@opentelemetry/api";
import {
  UI_ACTION_SCHEMA_VERSION,
  type ActionAnchorOptions,
  type CapturedInputValue,
  type CausedHttpTrace,
  type HttpSpanEndNotification,
  type HttpSpanStartNotification,
  type InputCaptureMode,
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
  type SemanticTarget,
  type SemanticVerb,
  type TextInputChangeEventLike,
  type TextInputHandlersLike,
  type WrappedTextInputHandlers,
} from "./types.js";

const UI_ACTION_SPAN_NAME = "softprobe.ui.action";
const DEFAULT_QUIET_MS = 40;
const DEFAULT_MAX_SETTLE_MS = 15_000;
const MAX_SUMMARY_CHARS = 300;
const MAX_ANCHORS = 8;
const DEFAULT_MOBILE_VIEWPORT = { width: 390, height: 844 } as const;

interface SettlingMobileAction {
  readonly actionIndex: number;
  readonly timestampMs: number;
  readonly startPath: string;
  endPath: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly verb: SemanticVerb;
  readonly baselineAnchors: readonly SemanticTarget[];
  readonly explicitEndAnchors: SemanticTarget[];
  readonly explicitGoneAnchors: SemanticTarget[];
  readonly causedTraces: CausedHttpTrace[];
  readonly inFlightSpanIds: Set<string>;
  quietTimer: ReturnType<typeof setTimeout> | null;
  maxTimer: ReturnType<typeof setTimeout> | null;
}

function boundText(raw: string, maxChars: number): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  return collapsed.length <= maxChars ? collapsed : collapsed.slice(0, maxChars);
}

function formatTargetSummary(target: SemanticTarget | undefined): string {
  if (!target) return "the screen";
  const label =
    target.name ??
    target.label ??
    target.nearbyLabel ??
    target.text ??
    target.placeholder ??
    target.testId ??
    target.accessibilityId ??
    "";
  const role = target.role?.trim() || "element";
  const cleanLabel = boundText(label, 40);
  return cleanLabel ? `${role} ${JSON.stringify(cleanLabel)}` : role;
}

export function formatMobileActionSummary(verb: SemanticVerb): string {
  const quote = (val: string) => JSON.stringify(boundText(val, 40));
  const raw = (() => {
    switch (verb.name) {
      case "navigate":
        return `navigate to ${quote(verb.url)}`;
      case "click":
        return `tap ${formatTargetSummary(verb.target)}`;
      case "dblclick":
        return `double-tap ${formatTargetSummary(verb.target)}`;
      case "contextmenu":
        return `secondary-tap ${formatTargetSummary(verb.target)}`;
      case "hover":
        return `hover over ${formatTargetSummary(verb.target)}`;
      case "fill": {
        const where = formatTargetSummary(verb.target);
        if (verb.value.kind === "secret") {
          return `fill secret ${quote(verb.value.slot)} into ${where}`;
        }
        if (verb.value.kind === "redacted") {
          return `fill ${where} (${verb.value.length} chars redacted)`;
        }
        return `type ${quote(verb.value.value)} into ${where}`;
      }
      case "select": {
        const where = formatTargetSummary(verb.target);
        if (verb.value.kind === "literal") {
          return `select ${quote(verb.optionLabel ?? verb.value.value)} in ${where}`;
        }
        return `select option in ${where}`;
      }
      case "check":
        return `${verb.checked ? "check" : "uncheck"} ${formatTargetSummary(verb.target)}`;
      case "press":
        return verb.target
          ? `press ${quote(verb.key)} on ${formatTargetSummary(verb.target)}`
          : `press ${quote(verb.key)}`;
      case "upload":
        return `upload ${verb.fileNames.map(quote).join(", ")} to ${formatTargetSummary(verb.target)}`;
      case "drag":
        return `drag ${formatTargetSummary(verb.source)} to ${formatTargetSummary(verb.destination)}`;
      case "scroll":
        return verb.target
          ? `scroll ${verb.direction} on ${formatTargetSummary(verb.target)}`
          : `scroll ${verb.direction}`;
      case "dialog":
        return `${verb.accepted ? "accept" : "dismiss"} ${verb.dialogType} dialog`;
      case "resize":
        return `resize the viewport to ${verb.viewport.width}x${verb.viewport.height}`;
      case "back":
        return "navigate back";
      case "dismissKeyboard":
        return "dismiss keyboard";
      case "openLink":
        return `open link ${quote(verb.url)}`;
      case "swipe":
        return verb.target
          ? `swipe ${verb.direction} on ${formatTargetSummary(verb.target)}`
          : `swipe ${verb.direction}`;
      case "longPress":
        return `long-press ${formatTargetSummary(verb.target)}`;
      default: {
        const _exhaustive: never = verb;
        return String(_exhaustive);
      }
    }
  })();
  return boundText(raw, MAX_SUMMARY_CHARS);
}

function normalizeSlotIdentifier(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "SECRET";
}

function matchConfiguredSecretSlot(
  target: SemanticTarget,
  secretSlots: Readonly<Record<string, string>> | undefined,
): string | undefined {
  if (!secretSlots) return undefined;
  const candidateKeys = [
    target.testId,
    target.accessibilityId,
    target.name,
    target.label,
    target.cssSelector,
  ];
  for (const key of candidateKeys) {
    if (!key) continue;
    const direct = secretSlots[key];
    if (typeof direct === "string" && direct.trim()) {
      return normalizeSlotIdentifier(direct);
    }
  }
  return undefined;
}

function classifyFillValue(
  target: SemanticTarget,
  rawValue: string,
  inputCapture: InputCaptureMode,
  secretSlots: Readonly<Record<string, string>> | undefined,
  options: RecordFillOptions | undefined,
): CapturedInputValue {
  if (options?.secretSlot?.trim()) {
    return { kind: "secret", slot: normalizeSlotIdentifier(options.secretSlot) };
  }

  const mappedSlot = matchConfiguredSecretSlot(target, secretSlots);
  if (mappedSlot) {
    return { kind: "secret", slot: mappedSlot };
  }

  const purpose = (target.inputPurpose ?? "").trim().toLowerCase();
  const isOtpPurpose = purpose === "one-time-code" || purpose === "otp";
  const secretFieldRe =
    /\b(password|passcode|passphrase|secret|token|cvv|cvc|otp|pin|api[-_]?key)\b/i;
  const hasSecretFieldName = [target.testId, target.name, target.placeholder].some(
    (candidate) => typeof candidate === "string" && secretFieldRe.test(candidate),
  );
  const isPasswordPurpose =
    options?.secureTextEntry === true ||
    purpose === "password" ||
    purpose === "current-password" ||
    purpose === "new-password" ||
    hasSecretFieldName;

  if (isOtpPurpose) {
    return { kind: "secret", slot: "OTP" };
  }
  if (isPasswordPurpose) {
    return { kind: "secret", slot: "PASSWORD" };
  }
  if (inputCapture === "masked") {
    return { kind: "redacted", length: rawValue.length };
  }
  return { kind: "literal", value: rawValue };
}

function sanitizeTargetForExport(
  target: SemanticTarget,
  stripValue: boolean,
): SemanticTarget {
  if (!stripValue || target.value === undefined) {
    return { ...target };
  }
  const { value: _omitted, ...rest } = target;
  return rest;
}

function inferTapPoint(
  target: SemanticTarget,
  explicitPoint: { readonly x: number; readonly y: number } | undefined,
): { readonly x: number; readonly y: number } {
  if (explicitPoint) {
    return {
      x: Math.round(explicitPoint.x),
      y: Math.round(explicitPoint.y),
    };
  }
  if (target.rect) {
    return {
      x: Math.round(target.rect.x + target.rect.width / 2),
      y: Math.round(target.rect.y + target.rect.height / 2),
    };
  }
  return { x: 0, y: 0 };
}

function isDirectPoint(
  value: { readonly x: number; readonly y: number } | RecordTapOptions | undefined,
): value is { readonly x: number; readonly y: number } {
  return (
    value !== undefined &&
    "x" in value &&
    "y" in value &&
    typeof value.x === "number" &&
    typeof value.y === "number"
  );
}

function isNavigationOptions(
  value: NavigationRouteChangeOptions | Readonly<Record<string, unknown>> | undefined,
): value is NavigationRouteChangeOptions {
  if (!value || typeof value !== "object") return false;
  return (
    "trigger" in value ||
    "params" in value ||
    "endAnchors" in value ||
    "goneAnchors" in value
  );
}

function hasExternalOrDeepLinkScheme(raw: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) || /^(mailto|tel|sms):/i.test(raw);
}

function normalizeRoutePath(
  rawRoute: string,
  params?: Readonly<Record<string, unknown>>,
): string {
  const trimmed = rawRoute.trim();
  if (!trimmed) return "/";
  const basePath = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (!params || basePath.includes("?")) return basePath;

  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      search.set(k, String(v));
    }
  }
  const query = search.toString();
  return query ? `${basePath}?${query}` : basePath;
}

function anchorKey(target: SemanticTarget): string {
  return JSON.stringify([
    target.role ?? "",
    target.testId ?? "",
    target.accessibilityId ?? "",
    target.name ?? "",
    target.label ?? "",
    target.text ?? "",
  ]);
}

function diffObservedAnchors(
  baseline: readonly SemanticTarget[],
  settled: readonly SemanticTarget[],
): {
  readonly endAnchors: readonly SemanticTarget[];
  readonly goneAnchors: readonly SemanticTarget[];
} {
  const baseKeys = new Set(baseline.map(anchorKey));
  const settledKeys = new Set(settled.map(anchorKey));

  const endAnchors: SemanticTarget[] = [];
  const seenEnd = new Set<string>();
  for (const item of settled) {
    const key = anchorKey(item);
    if (baseKeys.has(key) || seenEnd.has(key)) continue;
    seenEnd.add(key);
    endAnchors.push(item);
    if (endAnchors.length >= MAX_ANCHORS) break;
  }

  const goneAnchors: SemanticTarget[] = [];
  const seenGone = new Set<string>();
  for (const item of baseline) {
    const key = anchorKey(item);
    if (settledKeys.has(key) || seenGone.has(key)) continue;
    seenGone.add(key);
    goneAnchors.push(item);
    if (goneAnchors.length >= MAX_ANCHORS) break;
  }

  return { endAnchors, goneAnchors };
}

function dedupeAnchors(items: readonly SemanticTarget[]): SemanticTarget[] {
  const out: SemanticTarget[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const key = anchorKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...item });
    if (out.length >= MAX_ANCHORS) break;
  }
  return out;
}

export function createReactNativeActionRecorder(
  options: ReactNativeActionRecorderOptions,
): ReactNativeActionRecorder {
  const tracerOption = options.tracer;
  const getTracer: () => Tracer | undefined =
    typeof tracerOption === "function" ? tracerOption : () => tracerOption;
  const inputCapture: InputCaptureMode = options.inputCapture ?? "secrets-only";
  const quietMs = Math.max(0, options.quietMs ?? DEFAULT_QUIET_MS);
  const maxSettleMs = Math.max(quietMs, options.maxSettleMs ?? DEFAULT_MAX_SETTLE_MS);
  const now = options.now ?? Date.now;

  let currentPath = normalizeRoutePath(options.initialRoute ?? "/");
  let nextActionIndex = 0;
  let stopped = false;
  let settling: SettlingMobileAction | null = null;
  const spanOwnerBySpanId = new Map<string, SettlingMobileAction | null>();
  const idleWaiters = new Set<() => void>();

  const resolveViewport = (): { readonly width: number; readonly height: number } => {
    const candidate =
      options.getViewport?.() ??
      options.viewport ??
      (typeof globalThis.innerWidth === "number" &&
      globalThis.innerWidth > 0 &&
      typeof globalThis.innerHeight === "number" &&
      globalThis.innerHeight > 0
        ? { width: globalThis.innerWidth, height: globalThis.innerHeight }
        : DEFAULT_MOBILE_VIEWPORT);
    return {
      width: Math.max(1, Math.trunc(candidate.width)),
      height: Math.max(1, Math.trunc(candidate.height)),
    };
  };

  const snapshotAnchors = (): readonly SemanticTarget[] => {
    if (!options.observeAnchors) return [];
    try {
      return [...options.observeAnchors()];
    } catch {
      return [];
    }
  };

  const notifyIdleIfDone = (): void => {
    if (settling !== null || idleWaiters.size === 0) return;
    const waiters = [...idleWaiters];
    idleWaiters.clear();
    for (const resolve of waiters) {
      resolve();
    }
  };

  const emitActionSpan = (action: RecordedSemanticAction): void => {
    const tracer = getTracer();
    if (!tracer) return;

    const summary = formatMobileActionSummary(action.verb);
    const startTime = new Date(action.timestampMs);
    const endTime = new Date(action.timestampMs + Math.max(0, action.settleMs));

    const span = tracer.startSpan(UI_ACTION_SPAN_NAME, {
      startTime,
      attributes: {
        "sp.observation.type": "ui_action",
        "sp.ui.action.schema": UI_ACTION_SCHEMA_VERSION,
        "sp.ui.action.index": action.actionIndex,
        "sp.ui.action.verb": action.verb.name,
        "sp.ui.action.summary": summary,
        "sp.ui.action.start_path": action.startPath,
        "sp.ui.action.end_path": action.endPath,
        "sp.ui.action.platform": options.platform,
        "sp.ui.action.capture_source": "otel_sdk",
        "sp.ui.action.payload": `sp.json:${JSON.stringify(action)}`,
      },
    });
    try {
      span.setStatus({ code: SpanStatusCode.OK });
    } finally {
      span.end(endTime);
    }
  };

  const finalizeSettling = (settledSnapshotOverride?: readonly SemanticTarget[]): void => {
    const active = settling;
    if (!active) return;
    settling = null;

    if (active.quietTimer !== null) {
      clearTimeout(active.quietTimer);
      active.quietTimer = null;
    }
    if (active.maxTimer !== null) {
      clearTimeout(active.maxTimer);
      active.maxTimer = null;
    }

    const settledObserved = settledSnapshotOverride ?? snapshotAnchors();
    const observedDelta = diffObservedAnchors(active.baselineAnchors, settledObserved);

    const endAnchors = dedupeAnchors([
      ...active.explicitEndAnchors,
      ...observedDelta.endAnchors,
    ]);
    const goneAnchors = dedupeAnchors([
      ...active.explicitGoneAnchors,
      ...observedDelta.goneAnchors,
    ]);

    const settleMs = Math.max(0, now() - active.timestampMs);
    const recorded: RecordedSemanticAction = {
      schemaVersion: UI_ACTION_SCHEMA_VERSION,
      actionIndex: active.actionIndex,
      timestampMs: active.timestampMs,
      startPath: active.startPath,
      endPath: active.endPath,
      viewport: active.viewport,
      verb: active.verb,
      causedTraces: [...active.causedTraces],
      endAnchors,
      goneAnchors,
      settleMs,
      platform: options.platform,
      captureSource: "otel_sdk",
    };

    emitActionSpan(recorded);
    notifyIdleIfDone();
  };

  const scheduleQuietCheck = (active: SettlingMobileAction): void => {
    if (active.quietTimer !== null) {
      clearTimeout(active.quietTimer);
    }
    active.quietTimer = setTimeout(() => {
      if (settling !== active) return;
      if (active.inFlightSpanIds.size === 0) {
        finalizeSettling();
      }
    }, quietMs);
  };

  const beginAction = (
    verb: SemanticVerb,
    startPath: string,
    endPath: string,
    anchorOptions?: ActionAnchorOptions,
  ): void => {
    if (stopped) return;
    const currentSnapshot = snapshotAnchors();
    if (settling !== null) {
      finalizeSettling(currentSnapshot);
    }

    const entry: SettlingMobileAction = {
      actionIndex: nextActionIndex++,
      timestampMs: now(),
      startPath,
      endPath,
      viewport: resolveViewport(),
      verb,
      baselineAnchors: currentSnapshot,
      explicitEndAnchors: [...(anchorOptions?.endAnchors ?? [])],
      explicitGoneAnchors: [...(anchorOptions?.goneAnchors ?? [])],
      causedTraces: [],
      inFlightSpanIds: new Set(),
      quietTimer: null,
      maxTimer: null,
    };

    settling = entry;
    scheduleQuietCheck(entry);
    entry.maxTimer = setTimeout(() => {
      if (settling === entry) {
        finalizeSettling();
      }
    }, maxSettleMs);
  };

  return {
    get currentPath(): string {
      return currentPath;
    },

    onNavigationRouteChange(routeNameOrPath, paramsOrOptions): void {
      if (stopped) return;
      const navOpts = isNavigationOptions(paramsOrOptions)
        ? paramsOrOptions
        : paramsOrOptions
          ? { params: paramsOrOptions }
          : undefined;

      const raw = routeNameOrPath.trim();
      const trigger = navOpts?.trigger;

      if (trigger === "openLink" || hasExternalOrDeepLinkScheme(raw)) {
        if (!raw) return;
        beginAction(
          { name: "openLink", url: raw },
          currentPath,
          currentPath,
          navOpts,
        );
        return;
      }

      const nextPath = normalizeRoutePath(raw, navOpts?.params);
      const previousPath = currentPath;
      currentPath = nextPath;

      if (trigger === "back") {
        beginAction({ name: "back" }, previousPath, nextPath, navOpts);
        return;
      }

      if (
        settling !== null &&
        (settling.verb.name === "click" || settling.verb.name === "longPress")
      ) {
        settling.endPath = nextPath;
        if (navOpts?.endAnchors) {
          settling.explicitEndAnchors.push(...navOpts.endAnchors);
        }
        if (navOpts?.goneAnchors) {
          settling.explicitGoneAnchors.push(...navOpts.goneAnchors);
        }
        scheduleQuietCheck(settling);
        return;
      }

      if (nextPath === previousPath && trigger !== "load") {
        return;
      }

      beginAction(
        {
          name: "navigate",
          url: nextPath,
          trigger: trigger ?? "pushState",
        },
        previousPath,
        nextPath,
        navOpts,
      );
    },

    recordTap(target, pointOrOptions): void {
      const tapOpts: RecordTapOptions | undefined = isDirectPoint(pointOrOptions)
        ? { point: pointOrOptions }
        : pointOrOptions;
      const sanitized = sanitizeTargetForExport(
        target,
        Boolean(matchConfiguredSecretSlot(target, options.secretSlots)) ||
          ["password", "current-password", "new-password", "one-time-code", "otp"].includes(
            (target.inputPurpose ?? "").toLowerCase(),
          ),
      );
      const point = inferTapPoint(sanitized, tapOpts?.point);
      beginAction(
        {
          name: "click",
          target: sanitized,
          ...(tapOpts?.modifiers && tapOpts.modifiers.length > 0
            ? { modifiers: tapOpts.modifiers }
            : {}),
          point,
        },
        currentPath,
        currentPath,
        tapOpts,
      );
    },

    recordLongPress(target, longPressOptions): void {
      const sanitized = sanitizeTargetForExport(
        target,
        Boolean(matchConfiguredSecretSlot(target, options.secretSlots)),
      );
      const point = longPressOptions?.point
        ? {
            x: Math.round(longPressOptions.point.x),
            y: Math.round(longPressOptions.point.y),
          }
        : undefined;
      beginAction(
        {
          name: "longPress",
          target: sanitized,
          ...(point ? { point } : {}),
          ...(longPressOptions?.durationMs !== undefined
            ? { durationMs: longPressOptions.durationMs }
            : {}),
        },
        currentPath,
        currentPath,
        longPressOptions,
      );
    },

    recordSwipe(direction, target, distanceRatio, anchorOptions): void {
      const sanitized = target
        ? sanitizeTargetForExport(target, false)
        : undefined;
      beginAction(
        {
          name: "swipe",
          direction,
          ...(sanitized ? { target: sanitized } : {}),
          ...(distanceRatio !== undefined ? { distanceRatio } : {}),
        },
        currentPath,
        currentPath,
        anchorOptions,
      );
    },

    recordBack(backOptions): void {
      const previousPath = currentPath;
      if (backOptions?.toRoute) {
        currentPath = normalizeRoutePath(backOptions.toRoute);
      }
      beginAction({ name: "back" }, previousPath, currentPath, backOptions);
    },

    recordDismissKeyboard(anchorOptions): void {
      beginAction(
        { name: "dismissKeyboard" },
        currentPath,
        currentPath,
        anchorOptions,
      );
    },

    recordFill(target, rawValue, fillOptions): void {
      const capturedValue = classifyFillValue(
        target,
        rawValue,
        inputCapture,
        options.secretSlots,
        fillOptions,
      );
      const sanitizedTarget = sanitizeTargetForExport(target, true);
      beginAction(
        {
          name: "fill",
          target: sanitizedTarget,
          value: capturedValue,
          replace: fillOptions?.replace ?? true,
        },
        currentPath,
        currentPath,
        fillOptions,
      );
    },

    recordEndAnchors(anchors): void {
      if (stopped || !settling) return;
      settling.explicitEndAnchors.push(...anchors);
      scheduleQuietCheck(settling);
    },

    recordGoneAnchors(anchors): void {
      if (stopped || !settling) return;
      settling.explicitGoneAnchors.push(...anchors);
      scheduleQuietCheck(settling);
    },

    onHttpSpanStart(info: HttpSpanStartNotification): void {
      if (stopped) return;
      if (spanOwnerBySpanId.size > 512) {
        const oldest = spanOwnerBySpanId.keys().next().value;
        if (oldest !== undefined) spanOwnerBySpanId.delete(oldest);
      }
      spanOwnerBySpanId.set(info.spanId, settling);
      if (!settling) return;

      settling.inFlightSpanIds.add(info.spanId);
      const provisional: CausedHttpTrace = {
        traceId: info.traceId,
        spanId: info.spanId,
        method: info.method,
        url: info.url,
        ...(info.urlTemplate ? { urlTemplate: info.urlTemplate } : {}),
      };
      const existingIdx = settling.causedTraces.findIndex(
        (item) => item.spanId === info.spanId,
      );
      if (existingIdx >= 0) {
        settling.causedTraces[existingIdx] = provisional;
      } else {
        settling.causedTraces.push(provisional);
      }
    },

    onHttpSpanEnd(info: HttpSpanEndNotification): void {
      if (stopped) return;
      const active = settling;
      if (spanOwnerBySpanId.has(info.spanId)) {
        const owner = spanOwnerBySpanId.get(info.spanId) ?? null;
        spanOwnerBySpanId.delete(info.spanId);
        if (!active || owner !== active) {
          return;
        }
      }
      if (!active) return;

      active.inFlightSpanIds.delete(info.spanId);
      const completed: CausedHttpTrace = {
        traceId: info.traceId,
        spanId: info.spanId,
        method: info.method,
        url: info.url,
        ...(info.urlTemplate ? { urlTemplate: info.urlTemplate } : {}),
        ...(info.status !== undefined ? { status: info.status } : {}),
      };
      const existingIdx = active.causedTraces.findIndex(
        (item) => item.spanId === info.spanId,
      );
      if (existingIdx >= 0) {
        active.causedTraces[existingIdx] = completed;
      } else {
        active.causedTraces.push(completed);
      }

      if (active.inFlightSpanIds.size === 0) {
        scheduleQuietCheck(active);
      }
    },

    hasPendingWork(): boolean {
      return settling !== null;
    },

    flush(): void {
      if (settling !== null) {
        finalizeSettling();
      }
    },

    waitForIdle(): Promise<void> {
      if (settling === null) {
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        idleWaiters.add(resolve);
      });
    },

    shutdown(): void {
      if (stopped) return;
      if (settling !== null) {
        finalizeSettling();
      }
      stopped = true;
      spanOwnerBySpanId.clear();
      notifyIdleIfDone();
    },
  };
}

function isNavigationStateLike(value: unknown): value is ReactNavigationStateLike {
  return (
    value !== null &&
    typeof value === "object" &&
    "routes" in value &&
    Array.isArray((value as { routes?: unknown }).routes)
  );
}

export function getActiveRouteNameFromState(state: unknown): string | undefined {
  if (!isNavigationStateLike(state) || !state.routes || state.routes.length === 0) {
    return undefined;
  }

  const rawIndex = state.index;
  const resolvedIndex =
    typeof rawIndex === "number" &&
    Number.isInteger(rawIndex) &&
    rawIndex >= 0 &&
    rawIndex < state.routes.length
      ? rawIndex
      : state.routes.length - 1;

  const activeRoute: ReactNavigationRouteLike | undefined = state.routes[resolvedIndex];
  if (!activeRoute || typeof activeRoute !== "object") {
    return undefined;
  }

  if (activeRoute.state) {
    const nested = getActiveRouteNameFromState(activeRoute.state);
    if (nested) return nested;
  }

  if (typeof activeRoute.name === "string" && activeRoute.name.trim()) {
    return activeRoute.name.trim();
  }
  if (typeof activeRoute.path === "string" && activeRoute.path.trim()) {
    return activeRoute.path.trim();
  }
  return undefined;
}

export function createNavigationStateChangeHandler(
  actions: Pick<ReactNativeActionRecorder, "onNavigationRouteChange">,
  options?: NavigationRouteChangeOptions,
): (state: unknown) => void {
  return (state: unknown): void => {
    const routeName = getActiveRouteNameFromState(state);
    if (!routeName) return;
    actions.onNavigationRouteChange(routeName, options);
  };
}

function extractTouchPoint(
  event: ResponderTouchEventLike | undefined,
): { readonly x: number; readonly y: number } | undefined {
  const native = event?.nativeEvent;
  if (!native) return undefined;
  if (typeof native.pageX === "number" && typeof native.pageY === "number") {
    return { x: native.pageX, y: native.pageY };
  }
  if (typeof native.locationX === "number" && typeof native.locationY === "number") {
    return { x: native.locationX, y: native.locationY };
  }
  return undefined;
}

export function createResponderProps(
  actions: Pick<ReactNativeActionRecorder, "recordTap">,
  target: SemanticTarget,
  options?: ResponderPropsOptions,
): ReactNativeResponderProps {
  return {
    onStartShouldSetResponder(event: ResponderTouchEventLike): boolean {
      if (options?.onStartShouldSetResponder) {
        return options.onStartShouldSetResponder(event);
      }
      return options?.shouldSetResponder ?? true;
    },
    onResponderRelease(event: ResponderTouchEventLike): void {
      const point = options?.point ?? extractTouchPoint(event);
      actions.recordTap(target, {
        ...(point ? { point } : {}),
        ...(options?.modifiers ? { modifiers: options.modifiers } : {}),
        ...(options?.endAnchors ? { endAnchors: options.endAnchors } : {}),
        ...(options?.goneAnchors ? { goneAnchors: options.goneAnchors } : {}),
      });
      options?.onResponderRelease?.(event);
    },
  };
}

export function wrapTextInputHandlers<
  TEvent extends TextInputChangeEventLike = TextInputChangeEventLike,
>(
  actions: Pick<ReactNativeActionRecorder, "recordFill">,
  target: SemanticTarget,
  handlers?: TextInputHandlersLike<TEvent>,
): WrappedTextInputHandlers<TEvent> {
  let latestText: string | undefined;
  let dirty = false;

  const commitFill = (rawText: string | undefined): void => {
    if (rawText === undefined) return;
    dirty = false;
    actions.recordFill(target, rawText, {
      ...(handlers?.secureTextEntry !== undefined
        ? { secureTextEntry: handlers.secureTextEntry }
        : {}),
      ...(handlers?.secretSlot !== undefined
        ? { secretSlot: handlers.secretSlot }
        : {}),
      ...(handlers?.replace !== undefined ? { replace: handlers.replace } : {}),
      ...(handlers?.endAnchors ? { endAnchors: handlers.endAnchors } : {}),
      ...(handlers?.goneAnchors ? { goneAnchors: handlers.goneAnchors } : {}),
    });
  };

  return {
    onChangeText(text: string): void {
      latestText = text;
      dirty = true;
      if (handlers?.commitOnChange) {
        commitFill(text);
      }
      handlers?.onChangeText?.(text);
    },
    onEndEditing(event: TEvent): void {
      const eventText = event?.nativeEvent?.text;
      const textToCommit = typeof eventText === "string" ? eventText : latestText;
      if (dirty || typeof eventText === "string") {
        commitFill(textToCommit);
      }
      handlers?.onEndEditing?.(event);
    },
    onSubmitEditing(event: TEvent): void {
      const eventText = event?.nativeEvent?.text;
      const textToCommit = typeof eventText === "string" ? eventText : latestText;
      if (dirty || typeof eventText === "string") {
        commitFill(textToCommit);
      }
      handlers?.onSubmitEditing?.(event);
    },
    onBlur(event: TEvent): void {
      const eventText = event?.nativeEvent?.text;
      const textToCommit = typeof eventText === "string" ? eventText : latestText;
      if (dirty) {
        commitFill(textToCommit);
      }
      handlers?.onBlur?.(event);
    },
  };
}
