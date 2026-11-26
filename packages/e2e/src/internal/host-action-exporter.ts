import { createRequire } from "node:module";
import {
  defineEngine,
  parseKey,
  type EngineAttemptContext,
  type EngineCleanupContext,
  type EngineFixtureContext,
  type EngineHandle,
  type EngineObserveOptions,
  type EngineSnapshot,
  type LocatorAction,
  type LocatorExpression,
  type NodeRef,
  type OperationContext,
  type PointerAction,
  type SemanticNode,
  type ViewportPoint,
  type ViewportSize,
} from "e2e/engine";
import {
  UI_ACTION_SCHEMA_VERSION,
  type CapturedInputValue,
  type CausedHttpTrace,
  type RecordedSemanticAction,
  type SemanticAnchorState,
  type SemanticModifierKey,
  type SemanticTarget,
  type SemanticVerb,
} from "./ui-action-schema.js";
import type { BrowserAttemptLedger } from "./correlator.js";
import { mintSpanId, mintTraceId } from "./correlator.js";
import { formatAuthHeader } from "./sink-shared.js";

const UI_ACTION_SPAN_NAME = "softprobe.ui.action";
const MAX_ANCHORS = 8;
const MAX_SUMMARY_CHARS = 300;
const MAX_DESCRIPTOR_CHARS = 300;
const MAX_WITHIN_CHARS = 80;
const DEFAULT_LONG_PRESS_DURATION_MS = 1000;
const SHARED_SECRETS_SYMBOL = Symbol.for("e2e.sharedSecrets.v1");

const CONTAINER_ROLES = new Set([
  "row",
  "listitem",
  "article",
  "group",
  "region",
  "dialog",
  "tabpanel",
  "toolbar",
  "navigation",
  "list",
]);

const OBSERVABLE_ANCHOR_ROLES = new Set([
  "alert",
  "alertdialog",
  "status",
  "dialog",
  "heading",
  "button",
  "link",
  "option",
  "row",
  "cell",
  "listitem",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "switch",
  "combobox",
  "listbox",
  "tab",
  "spinbutton",
  "text",
]);

const VOLATILE_TEXT_PATTERNS = [
  /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?/,
  /\b\d{4}-\d{2}-\d{2}\b/,
  /\b\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]\.?m\.?)?\b/i,
  /\b\d+\s*(?:ms|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?)\b/i,
  /^\d{1,3}%$/,
  /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{16,}\b/,
];

export type HostCapturePlatform = "ios" | "android" | "web";

export interface HostActionSinkDestination {
  readonly endpoint: string;
  readonly token?: string | undefined;
  readonly workspaceId?: string | undefined;
  readonly serviceName?: string | undefined;
}

export interface HostActionAttemptBinding {
  readonly sessionId: string;
  readonly ledger?: BrowserAttemptLedger | undefined;
  readonly sink?: HostActionSinkDestination | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly secretSlots?: Readonly<Record<string, string>> | undefined;
}

export interface HostActionCaptureOptions {
  readonly platform: HostCapturePlatform;
  readonly resolveAttemptBinding: () => HostActionAttemptBinding | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly now?: (() => number) | undefined;
  readonly enabled?: boolean | undefined;
}

export interface HostActionExporterController {
  recordResponseStatus(spanId: string, status: number): void;
  recordBackAction(operation?: OperationContext): Promise<void>;
  recordOpenLinkAction(url: string, operation?: OperationContext): Promise<void>;
  recordDismissKeyboardAction(operation?: OperationContext): Promise<void>;
  getRecordedActions(): readonly RecordedSemanticAction[];
  flush(signal?: AbortSignal): Promise<void>;
  resetAttempt(): void;
}

interface IndexedNodeEntry {
  readonly node: SemanticNode;
  readonly within?: string | undefined;
  readonly position?: { readonly index: number; readonly of: number } | undefined;
}

interface AnchorProjection {
  readonly key: string;
  readonly target: SemanticTarget;
}

interface ProjectedSnapshotState {
  readonly path: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly anchors: readonly AnchorProjection[];
  readonly focusedNode?: IndexedNodeEntry | undefined;
  readonly allEntries: readonly IndexedNodeEntry[];
}

interface PendingHostAction {
  readonly actionIndex: number;
  readonly timestampMs: number;
  readonly completedAtMs: number;
  readonly startPath: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly verb: SemanticVerb;
  readonly baselineAnchors: readonly AnchorProjection[];
  readonly ledgerStartIndex: number;
  postSnapshot?: ProjectedSnapshotState | undefined;
}

function collapseWhitespace(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

function boundText(raw: string, maxChars: number): string {
  const collapsed = collapseWhitespace(raw);
  return collapsed.length <= maxChars ? collapsed : collapsed.slice(0, maxChars);
}

function normalizeViewport(
  raw: ViewportSize | undefined,
): { readonly width: number; readonly height: number } {
  const width = raw && Number.isFinite(raw.width) && raw.width > 0 ? Math.round(raw.width) : 390;
  const height =
    raw && Number.isFinite(raw.height) && raw.height > 0 ? Math.round(raw.height) : 844;
  return {
    width: Math.max(1, width),
    height: Math.max(1, height),
  };
}

function normalizeSnapshotPath(location: string | undefined): string {
  if (!location || location.trim() === "") {
    return "/";
  }
  const trimmed = collapseWhitespace(location);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      return `${parsed.pathname || "/"}${parsed.search}`;
    } catch {
      return trimmed;
    }
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function isVolatileText(text: string): boolean {
  const clean = collapseWhitespace(text);
  if (clean === "") return true;
  return VOLATILE_TEXT_PATTERNS.some((pattern) => pattern.test(clean));
}

const SECRET_FIELD_NAME_RE =
  /\b(password|passcode|passphrase|secret|token|cvv|cvc|otp|pin|api[-_]?key)\b/i;

function isSecureNode(node: SemanticNode | undefined): boolean {
  if (!node) return false;
  if (node.states?.secure === true) return true;
  if (
    node.inputPurpose === "password" ||
    node.inputPurpose === "one-time-code" ||
    node.inputPurpose === "generic-secret"
  ) {
    return true;
  }
  return [node.testId, node.name, extractPlaceholder(node)].some(
    (candidate) => typeof candidate === "string" && SECRET_FIELD_NAME_RE.test(candidate),
  );
}

function extractAnchorStates(
  states: SemanticNode["states"],
): readonly SemanticAnchorState[] | undefined {
  if (!states) return undefined;
  const active: SemanticAnchorState[] = [];
  if (states.checked === true) active.push("checked");
  if (states.expanded === true) active.push("expanded");
  if (states.pressed === true) active.push("pressed");
  if (states.selected === true) active.push("selected");
  return active.length > 0 ? active : undefined;
}

function collectKnownSecrets(
  env: Readonly<Record<string, string | undefined>> | undefined,
): ReadonlyMap<string, string> {
  const valueToSlot = new Map<string, string>();

  const sharedRaw: unknown = Reflect.get(globalThis, SHARED_SECRETS_SYMBOL);
  if (
    typeof sharedRaw === "object" &&
    sharedRaw !== null &&
    "values" in sharedRaw &&
    sharedRaw.values instanceof Map
  ) {
    for (const held of sharedRaw.values.values()) {
      if (
        typeof held === "object" &&
        held !== null &&
        "entry" in held &&
        Array.isArray(held.entry) &&
        typeof held.entry[0] === "string" &&
        typeof held.entry[1] === "string" &&
        held.entry[1].length > 0
      ) {
        valueToSlot.set(held.entry[1], held.entry[0]);
      }
    }
  }

  for (const [key, val] of Object.entries(env ?? {})) {
    if (typeof val !== "string" || val.length === 0) continue;
    if (key.startsWith("SP_SECRET_") && key.length > "SP_SECRET_".length) {
      const slot = key.slice("SP_SECRET_".length);
      if (!valueToSlot.has(val)) {
        valueToSlot.set(val, slot);
      }
    } else if (key.startsWith("E2E_SECRET_") && key.length > "E2E_SECRET_".length) {
      const slot = key.slice("E2E_SECRET_".length);
      if (!valueToSlot.has(val)) {
        valueToSlot.set(val, slot);
      }
    } else if (key.startsWith("E2E_USER_") && key.endsWith("_PASSWORD")) {
      const userPart = key.slice("E2E_USER_".length, -"_PASSWORD".length);
      if (userPart && !valueToSlot.has(val)) {
        valueToSlot.set(val, `${userPart.toLowerCase()}.password`);
      }
    }
  }

  return valueToSlot;
}

function scrubSecretsInString(
  text: string,
  valueToSlot: ReadonlyMap<string, string>,
): string {
  if (text === "" || valueToSlot.size === 0) return text;
  let result = text;
  const sorted = [...valueToSlot.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [secretPlaintext, slot] of sorted) {
    if (secretPlaintext.length >= 4 && result.includes(secretPlaintext)) {
      result = result.split(secretPlaintext).join(`[REDACTED:${slot}]`);
    }
  }
  return result;
}

function sanitizeSlotIdentifier(raw: string): string {
  const cleaned = raw
    .replace(/^.*:id\//, "")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  return cleaned || "SECRET_INPUT";
}

function resolveSlotFromMapping(
  node: SemanticNode | undefined,
  secretSlots: Readonly<Record<string, string>> | undefined,
): string | undefined {
  if (!node || !secretSlots) return undefined;
  const candidates = [
    node.testId,
    node.testId?.replace(/^.*:id\//, ""),
    node.name,
    node.attributes?.["placeholder"],
  ].filter((item): item is string => typeof item === "string" && item.trim() !== "");

  for (const key of candidates) {
    const direct = secretSlots[key];
    if (direct && direct.trim() !== "") {
      return direct.trim();
    }
  }
  return undefined;
}

function resolveCapturedInputValue(input: {
  readonly rawValue: string;
  readonly sensitive: boolean;
  readonly entry: IndexedNodeEntry | undefined;
  readonly valueToSlot: ReadonlyMap<string, string>;
  readonly secretSlots: Readonly<Record<string, string>> | undefined;
}): CapturedInputValue {
  const mappedSlot = resolveSlotFromMapping(input.entry?.node, input.secretSlots);
  if (mappedSlot !== undefined) {
    return { kind: "secret", slot: mappedSlot };
  }

  const matchedKnownSlot = input.valueToSlot.get(input.rawValue);
  if (matchedKnownSlot !== undefined) {
    return { kind: "secret", slot: matchedKnownSlot };
  }

  if (input.sensitive || isSecureNode(input.entry?.node)) {
    const fallbackHint =
      input.entry?.node.name ??
      input.entry?.node.testId ??
      input.entry?.node.attributes?.["placeholder"] ??
      "SECRET_INPUT";
    return {
      kind: "secret",
      slot: sanitizeSlotIdentifier(fallbackHint),
    };
  }

  return {
    kind: "literal",
    value: scrubSecretsInString(input.rawValue, input.valueToSlot),
  };
}

function extractPlaceholder(node: SemanticNode): string | undefined {
  const raw =
    node.attributes?.["placeholder"] ??
    node.attributes?.["hint"] ??
    undefined;
  if (!raw || raw.trim() === "") return undefined;
  return boundText(raw, MAX_DESCRIPTOR_CHARS);
}

function buildSemanticTargetFromEntry(
  entry: IndexedNodeEntry,
  platform: HostCapturePlatform,
  valueToSlot: ReadonlyMap<string, string>,
): SemanticTarget {
  const { node } = entry;
  const secure = isSecureNode(node);
  const rawTestId = node.testId?.trim() ? node.testId.trim() : undefined;
  const role = node.role?.trim() ? node.role.trim() : undefined;
  const name = node.name?.trim()
    ? boundText(scrubSecretsInString(node.name, valueToSlot), MAX_DESCRIPTOR_CHARS)
    : undefined;
  const text =
    !secure && node.text?.trim()
      ? boundText(scrubSecretsInString(node.text, valueToSlot), MAX_DESCRIPTOR_CHARS)
      : undefined;
  const placeholderRaw = extractPlaceholder(node);
  const placeholder = placeholderRaw
    ? boundText(scrubSecretsInString(placeholderRaw, valueToSlot), MAX_DESCRIPTOR_CHARS)
    : undefined;
  const inputPurpose =
    node.inputPurpose && node.inputPurpose !== "none" ? node.inputPurpose : undefined;
  const states = extractAnchorStates(node.states);
  const value =
    !secure && node.value !== undefined && node.value.trim() !== ""
      ? boundText(scrubSecretsInString(node.value, valueToSlot), MAX_DESCRIPTOR_CHARS)
      : undefined;
  const rect =
    node.rect !== undefined
      ? {
          x: Math.round(node.rect.x),
          y: Math.round(node.rect.y),
          width: Math.round(node.rect.width),
          height: Math.round(node.rect.height),
        }
      : undefined;

  const isMobile = platform === "ios" || platform === "android";

  return {
    ...(rawTestId !== undefined ? { testId: rawTestId } : {}),
    ...(isMobile && rawTestId !== undefined ? { accessibilityId: rawTestId } : {}),
    ...(role !== undefined ? { role } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(placeholder !== undefined ? { placeholder } : {}),
    ...(inputPurpose !== undefined ? { inputPurpose } : {}),
    ...(entry.within !== undefined ? { within: entry.within } : {}),
    ...(entry.position !== undefined ? { position: entry.position } : {}),
    ...(rect !== undefined ? { rect } : {}),
    ...(node.framePath && node.framePath.length > 0 ? { framePath: node.framePath } : {}),
    ...(states !== undefined ? { states } : {}),
    ...(value !== undefined ? { value } : {}),
    interactive: role !== undefined && role !== "text" && role !== "group" && role !== "generic",
  };
}

function centerPointOfTarget(
  target: SemanticTarget,
  fallbackViewport: { readonly width: number; readonly height: number },
): { readonly x: number; readonly y: number } {
  if (target.rect !== undefined) {
    return {
      x: Math.round(target.rect.x + target.rect.width / 2),
      y: Math.round(target.rect.y + target.rect.height / 2),
    };
  }
  return {
    x: Math.round(fallbackViewport.width / 2),
    y: Math.round(fallbackViewport.height / 2),
  };
}

function nodeTwinSignature(node: SemanticNode): string {
  return `${node.role ?? ""}|${node.testId ?? ""}|${node.name ?? ""}`;
}

function containerLabelOf(node: SemanticNode): string | undefined {
  if (!node.role || !CONTAINER_ROLES.has(node.role)) {
    return undefined;
  }
  const label = node.name?.trim() || node.text?.trim();
  if (!label || isVolatileText(label)) {
    return undefined;
  }
  return boundText(label, MAX_WITHIN_CHARS);
}

function projectEngineSnapshot(
  snapshot: EngineSnapshot,
  platform: HostCapturePlatform,
  valueToSlot: ReadonlyMap<string, string>,
  nodeIndexMap: Map<string, IndexedNodeEntry>,
): ProjectedSnapshotState {
  const viewport = normalizeViewport(snapshot.viewport);
  const path = normalizeSnapshotPath(snapshot.location);

  interface RawTraversed {
    readonly node: SemanticNode;
    readonly within: string | undefined;
    readonly isLeaf: boolean;
  }

  const traversed: RawTraversed[] = [];
  const visit = (node: SemanticNode, inheritedWithin: string | undefined, isRoot: boolean): void => {
    const children = node.children ?? [];
    const ownContainerLabel = !isRoot ? containerLabelOf(node) : undefined;
    const nextWithin = ownContainerLabel ?? inheritedWithin;
    if (!isRoot) {
      traversed.push({
        node,
        within: inheritedWithin,
        isLeaf: children.length === 0,
      });
    }
    for (const child of children) {
      visit(child, nextWithin, false);
    }
  };

  visit(snapshot.root, undefined, true);

  const twinGroups = new Map<string, SemanticNode[]>();
  for (const item of traversed) {
    const sig = nodeTwinSignature(item.node);
    if (sig === "||") continue;
    const bucket = twinGroups.get(sig);
    if (bucket) {
      bucket.push(item.node);
    } else {
      twinGroups.set(sig, [item.node]);
    }
  }

  const allEntries: IndexedNodeEntry[] = [];
  const anchors: AnchorProjection[] = [];
  const seenAnchorKeys = new Set<string>();
  let focusedNode: IndexedNodeEntry | undefined;

  for (const item of traversed) {
    const sig = nodeTwinSignature(item.node);
    const twins = sig !== "||" ? twinGroups.get(sig) : undefined;
    let position: { readonly index: number; readonly of: number } | undefined;
    if (twins && twins.length > 1) {
      const idx = twins.indexOf(item.node);
      if (idx >= 0) {
        position = { index: idx, of: twins.length };
      }
    }

    const entry: IndexedNodeEntry = {
      node: item.node,
      within: item.within,
      position,
    };
    nodeIndexMap.set(item.node.ref.id, entry);
    allEntries.push(entry);

    if (item.node.states?.focused === true) {
      focusedNode = entry;
    }

    if (item.node.states?.hidden === true || isSecureNode(item.node)) {
      continue;
    }
    const role = item.node.role ?? "";
    if (!OBSERVABLE_ANCHOR_ROLES.has(role)) {
      continue;
    }
    if (!item.isLeaf && role === "group") {
      continue;
    }

    const primaryLabel = item.node.name?.trim() || item.node.text?.trim() || "";
    const hasStableTestId = Boolean(item.node.testId?.trim());
    if (primaryLabel === "" && !hasStableTestId) {
      continue;
    }
    if (primaryLabel !== "" && isVolatileText(primaryLabel)) {
      continue;
    }

    const fullTarget = buildSemanticTargetFromEntry(entry, platform, valueToSlot);
    const anchorTarget: SemanticTarget = {
      ...(fullTarget.testId !== undefined ? { testId: fullTarget.testId } : {}),
      ...(fullTarget.accessibilityId !== undefined
        ? { accessibilityId: fullTarget.accessibilityId }
        : {}),
      ...(fullTarget.role !== undefined ? { role: fullTarget.role } : {}),
      ...(fullTarget.name !== undefined ? { name: fullTarget.name } : {}),
      ...(fullTarget.text !== undefined ? { text: fullTarget.text } : {}),
      ...(fullTarget.value !== undefined ? { value: fullTarget.value } : {}),
      ...(fullTarget.states !== undefined ? { states: fullTarget.states } : {}),
    };
    const key = JSON.stringify([
      anchorTarget.role ?? "",
      anchorTarget.testId ?? "",
      anchorTarget.name ?? "",
      anchorTarget.text ?? "",
      anchorTarget.value ?? "",
      anchorTarget.states?.join(",") ?? "",
    ]);
    if (!seenAnchorKeys.has(key)) {
      seenAnchorKeys.add(key);
      anchors.push({ key, target: anchorTarget });
    }
  }

  return {
    path,
    viewport,
    anchors,
    focusedNode,
    allEntries,
  };
}

function anchorSubsumedByTarget(
  candidateGone: SemanticTarget,
  afterTarget: SemanticTarget,
): boolean {
  if (candidateGone.role !== undefined && candidateGone.role !== afterTarget.role) {
    return false;
  }
  if (candidateGone.testId !== undefined && candidateGone.testId !== afterTarget.testId) {
    return false;
  }
  if (candidateGone.name !== undefined && candidateGone.name !== afterTarget.name) {
    return false;
  }
  if (candidateGone.text !== undefined && candidateGone.text !== afterTarget.text) {
    return false;
  }
  if (candidateGone.value !== undefined && candidateGone.value !== afterTarget.value) {
    return false;
  }
  const goneStates = candidateGone.states?.join(",") ?? "";
  const afterStates = afterTarget.states?.join(",") ?? "";
  return goneStates === afterStates;
}

function computeAnchorDiff(
  before: readonly AnchorProjection[],
  after: readonly AnchorProjection[],
): {
  readonly endAnchors: readonly SemanticTarget[];
  readonly goneAnchors: readonly SemanticTarget[];
} {
  const beforeKeys = new Set(before.map((item) => item.key));
  const afterKeys = new Set(after.map((item) => item.key));

  const endAnchors: SemanticTarget[] = [];
  for (const item of after) {
    if (!beforeKeys.has(item.key)) {
      endAnchors.push(item.target);
      if (endAnchors.length >= MAX_ANCHORS) break;
    }
  }

  const goneAnchors: SemanticTarget[] = [];
  for (const item of before) {
    if (
      !afterKeys.has(item.key) &&
      !after.some((afterItem) => anchorSubsumedByTarget(item.target, afterItem.target))
    ) {
      goneAnchors.push(item.target);
      if (goneAnchors.length >= MAX_ANCHORS) break;
    }
  }

  return { endAnchors, goneAnchors };
}

function hitTestPoint(
  point: ViewportPoint,
  entries: readonly IndexedNodeEntry[],
): IndexedNodeEntry | undefined {
  let best: IndexedNodeEntry | undefined;
  let bestArea = Number.POSITIVE_INFINITY;
  for (const entry of entries) {
    const rect = entry.node.rect;
    if (!rect || rect.width <= 0 || rect.height <= 0) continue;
    if (entry.node.states?.hidden === true) continue;
    const inside =
      point.x >= rect.x &&
      point.x <= rect.x + rect.width &&
      point.y >= rect.y &&
      point.y <= rect.y + rect.height;
    if (!inside) continue;
    const area = rect.width * rect.height;
    if (area <= bestArea) {
      bestArea = area;
      best = entry;
    }
  }
  return best;
}

function normalizeModifiers(
  modifiers: readonly string[] | undefined,
): readonly SemanticModifierKey[] | undefined {
  if (!modifiers || modifiers.length === 0) return undefined;
  const out: SemanticModifierKey[] = [];
  for (const mod of modifiers) {
    if (mod === "Alt" || mod === "Control" || mod === "Meta" || mod === "Shift") {
      if (!out.includes(mod)) out.push(mod);
    } else if (mod === "ControlOrMeta") {
      const mapped: SemanticModifierKey = process.platform === "darwin" ? "Meta" : "Control";
      if (!out.includes(mapped)) out.push(mapped);
    }
  }
  return out.length > 0 ? out : undefined;
}

function formatTargetSummary(target: SemanticTarget | undefined): string {
  if (!target) return "screen";
  const label =
    target.name ??
    target.label ??
    target.nearbyLabel ??
    target.placeholder ??
    target.text ??
    target.accessibilityId ??
    target.testId ??
    "";
  const trimmed = collapseWhitespace(label).slice(0, 48);
  const role = target.role?.trim() || "element";
  return trimmed === "" ? role : `${role} ${JSON.stringify(trimmed)}`;
}

export function formatHostSemanticActionSummary(verb: SemanticVerb): string {
  let raw: string;
  switch (verb.name) {
    case "click":
      raw = `tap ${formatTargetSummary(verb.target)}`;
      break;
    case "dblclick":
      raw = `double-tap ${formatTargetSummary(verb.target)}`;
      break;
    case "contextmenu":
      raw = `secondary-tap ${formatTargetSummary(verb.target)}`;
      break;
    case "hover":
      raw = `hover ${formatTargetSummary(verb.target)}`;
      break;
    case "longPress":
      raw = `long-press ${formatTargetSummary(verb.target)}`;
      break;
    case "fill": {
      const valueDesc =
        verb.value.kind === "secret"
          ? `secret ${verb.value.slot}`
          : verb.value.kind === "redacted"
            ? `[redacted ${verb.value.length} chars]`
            : JSON.stringify(boundText(verb.value.value, 40));
      raw = `fill ${valueDesc} into ${formatTargetSummary(verb.target)}`;
      break;
    }
    case "select":
      raw = `select on ${formatTargetSummary(verb.target)}`;
      break;
    case "check":
      raw = `${verb.checked ? "check" : "uncheck"} ${formatTargetSummary(verb.target)}`;
      break;
    case "press":
      raw = verb.target
        ? `press ${verb.key} on ${formatTargetSummary(verb.target)}`
        : `press ${verb.key}`;
      break;
    case "upload":
      raw = `upload ${verb.fileNames.length} file(s) to ${formatTargetSummary(verb.target)}`;
      break;
    case "drag":
      raw = `drag ${formatTargetSummary(verb.source)} to ${formatTargetSummary(verb.destination)}`;
      break;
    case "scroll":
      raw = verb.target
        ? `scroll ${verb.direction} on ${formatTargetSummary(verb.target)}`
        : `scroll ${verb.direction}`;
      break;
    case "swipe":
      raw = verb.target
        ? `swipe ${verb.direction} on ${formatTargetSummary(verb.target)}`
        : `swipe ${verb.direction}`;
      break;
    case "back":
      raw = "navigate back";
      break;
    case "dismissKeyboard":
      raw = "dismiss keyboard";
      break;
    case "openLink":
      raw = `open link ${verb.url}`;
      break;
    case "navigate":
      raw = `navigate to ${verb.url}`;
      break;
    case "dialog":
      raw = `${verb.accepted ? "accept" : "dismiss"} ${verb.dialogType}`;
      break;
    case "resize":
      raw = `resize ${verb.viewport.width}x${verb.viewport.height}`;
      break;
    default: {
      const _exhaustive: never = verb;
      raw = String(_exhaustive);
    }
  }
  return boundText(raw, MAX_SUMMARY_CHARS);
}

function computeSwipeFromPoints(
  from: ViewportPoint,
  to: ViewportPoint,
  viewport: { readonly width: number; readonly height: number },
): {
  readonly direction: "up" | "down" | "left" | "right";
  readonly distanceRatio: number;
} {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dy) >= Math.abs(dx)) {
    const direction = dy < 0 ? "up" : "down";
    const ratio = Math.min(1, Math.max(0.05, Number((Math.abs(dy) / viewport.height).toFixed(2))));
    return { direction, distanceRatio: ratio };
  }
  const direction = dx < 0 ? "left" : "right";
  const ratio = Math.min(1, Math.max(0.05, Number((Math.abs(dx) / viewport.width).toFixed(2))));
  return { direction, distanceRatio: ratio };
}

function buildOtlpTracesPayload(input: {
  readonly actions: readonly RecordedSemanticAction[];
  readonly sessionId: string;
  readonly platform: HostCapturePlatform;
  readonly serviceName: string;
  readonly valueToSlot: ReadonlyMap<string, string>;
}): Record<string, unknown> {
  const spans = input.actions.map((action) => {
    const summary = scrubSecretsInString(
      formatHostSemanticActionSummary(action.verb),
      input.valueToSlot,
    );
    const payloadJson = scrubSecretsInString(JSON.stringify(action), input.valueToSlot);
    const startNs = BigInt(Math.trunc(action.timestampMs)) * 1_000_000n;
    const endNs =
      BigInt(Math.trunc(action.timestampMs + Math.max(1, action.settleMs))) * 1_000_000n;

    return {
      traceId: mintTraceId(),
      spanId: mintSpanId(),
      name: UI_ACTION_SPAN_NAME,
      kind: 1,
      startTimeUnixNano: String(startNs),
      endTimeUnixNano: String(endNs),
      status: { code: 1 },
      attributes: [
        { key: "sp.observation.type", value: { stringValue: "ui_action" } },
        { key: "sp.ui.action.schema", value: { stringValue: UI_ACTION_SCHEMA_VERSION } },
        { key: "sp.ui.action.index", value: { intValue: action.actionIndex } },
        { key: "sp.ui.action.verb", value: { stringValue: action.verb.name } },
        { key: "sp.ui.action.summary", value: { stringValue: summary } },
        { key: "sp.ui.action.start_path", value: { stringValue: action.startPath } },
        { key: "sp.ui.action.end_path", value: { stringValue: action.endPath } },
        { key: "sp.ui.action.platform", value: { stringValue: input.platform } },
        { key: "sp.ui.action.capture_source", value: { stringValue: "host_agent" } },
        { key: "sp.ui.action.payload", value: { stringValue: `sp.json:${payloadJson}` } },
        { key: "sp.session.id", value: { stringValue: input.sessionId } },
      ],
    };
  });

  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: input.serviceName } },
            { key: "sp.capture.source", value: { stringValue: "host_agent" } },
            { key: "sp.platform", value: { stringValue: input.platform } },
          ],
        },
        scopeSpans: [
          {
            scope: {
              name: "@softprobe/e2e",
              version: PACKAGE_VERSION,
            },
            spans,
          },
        ],
      },
    ],
  };
}

function resolveOwnPackageVersion(): string {
  try {
    const raw: unknown = createRequire(import.meta.url)("../../package.json");
    if (
      typeof raw === "object" &&
      raw !== null &&
      "version" in raw &&
      typeof raw.version === "string"
    ) {
      return raw.version;
    }
  } catch {
    return "0.0.0";
  }
  return "0.0.0";
}

const PACKAGE_VERSION = resolveOwnPackageVersion();

export function wrapEngineWithHostActionCapture<Fixtures extends object>(
  base: EngineHandle<Fixtures>,
  options: HostActionCaptureOptions,
): {
  readonly engine: EngineHandle<Fixtures>;
  readonly exporter: HostActionExporterController;
} {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const enabled = options.enabled !== false;

  const nodeIndexById = new Map<string, IndexedNodeEntry>();
  const statusBySpanId = new Map<string, number>();
  let latestSnapshot: ProjectedSnapshotState | undefined;
  let pendingAction: PendingHostAction | undefined;
  let nextActionIndex = 0;
  let unexportedActions: RecordedSemanticAction[] = [];
  let recordedHistory: RecordedSemanticAction[] = [];

  const resetAttemptState = (): void => {
    nodeIndexById.clear();
    statusBySpanId.clear();
    latestSnapshot = undefined;
    pendingAction = undefined;
    nextActionIndex = 0;
    unexportedActions = [];
    recordedHistory = [];
  };

  const currentSecretsMap = (): ReadonlyMap<string, string> => {
    const binding = options.resolveAttemptBinding();
    return collectKnownSecrets(binding?.env);
  };

  const ingestSnapshot = (snapshot: EngineSnapshot): void => {
    if (!enabled || snapshot.treeUnavailable === true) return;
    const projected = projectEngineSnapshot(
      snapshot,
      options.platform,
      currentSecretsMap(),
      nodeIndexById,
    );
    latestSnapshot = projected;
    if (pendingAction !== undefined) {
      pendingAction.postSnapshot = projected;
    }
  };

  const finalizePendingAction = (): void => {
    if (!enabled || pendingAction === undefined) return;
    const active = pendingAction;
    pendingAction = undefined;

    const settled = active.postSnapshot;
    const { endAnchors, goneAnchors } =
      settled !== undefined
        ? computeAnchorDiff(active.baselineAnchors, settled.anchors)
        : { endAnchors: [], goneAnchors: [] };
    const endPath = settled?.path ?? active.startPath;

    const binding = options.resolveAttemptBinding();
    const ledgerEntries = binding?.ledger?.rootView() ?? [];
    const slicedTriggers = ledgerEntries.slice(active.ledgerStartIndex);
    const causedTraces: CausedHttpTrace[] = slicedTriggers.map((entry) => {
      const knownStatus = statusBySpanId.get(entry.spanId);
      return {
        traceId: entry.traceId,
        spanId: entry.spanId,
        method: entry.method,
        url: entry.url,
        ...(knownStatus !== undefined ? { status: knownStatus } : {}),
      };
    });

    const settleMs = Math.max(0, now() - active.timestampMs);
    const record: RecordedSemanticAction = {
      schemaVersion: UI_ACTION_SCHEMA_VERSION,
      actionIndex: active.actionIndex,
      timestampMs: active.timestampMs,
      startPath: active.startPath,
      endPath,
      viewport: active.viewport,
      verb: active.verb,
      causedTraces,
      endAnchors,
      goneAnchors,
      settleMs,
      platform: options.platform,
      captureSource: "host_agent",
    };

    unexportedActions.push(record);
    recordedHistory.push(record);
  };

  const ensurePostSnapshotForPending = async (signal?: AbortSignal): Promise<void> => {
    if (!enabled || pendingAction === undefined || pendingAction.postSnapshot !== undefined) {
      return;
    }
    if (!base.observe) return;
    const opSignal = signal ?? AbortSignal.timeout(2_500);
    if (opSignal.aborted) return;
    try {
      const snap = await base.observe({
        signal: opSignal,
        timeoutMs: 2_500,
        runId: "flush",
        attemptId: "flush",
        origin: "test",
      });
      ingestSnapshot(snap);
    } catch {
      return;
    }
  };

  const flushExportQueue = async (signal?: AbortSignal): Promise<void> => {
    if (!enabled) return;
    await ensurePostSnapshotForPending(signal);
    finalizePendingAction();

    if (unexportedActions.length === 0) return;
    const binding = options.resolveAttemptBinding();
    if (!binding?.sink?.endpoint) {
      return;
    }

    const batch = [...unexportedActions];
    const cleanEndpoint = binding.sink.endpoint.trim().replace(/\/+$/, "");
    const tracesUrl = cleanEndpoint.endsWith("/v1/traces")
      ? cleanEndpoint
      : `${cleanEndpoint}/v1/traces`;
    const bodyObject = buildOtlpTracesPayload({
      actions: batch,
      sessionId: binding.sessionId,
      platform: options.platform,
      serviceName: binding.sink.serviceName?.trim() || "softprobe-e2e-mobile",
      valueToSlot: collectKnownSecrets(binding.env),
    });

    const timeoutSignal = AbortSignal.timeout(5_000);
    const combinedSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;

    try {
      const res = await fetchImpl(tracesUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...formatAuthHeader(binding.sink.token),
          ...(binding.sink.workspaceId
            ? { "X-Workspace-Id": binding.sink.workspaceId }
            : {}),
        },
        body: JSON.stringify(bodyObject),
        signal: combinedSignal,
      });
      await res.arrayBuffer().catch(() => undefined);
      if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) {
        unexportedActions.splice(0, batch.length);
      }
    } catch {
      return;
    }
  };

  const beginActionBeforeCall = (): {
    readonly timestampMs: number;
    readonly startPath: string;
    readonly viewport: { readonly width: number; readonly height: number };
    readonly baselineAnchors: readonly AnchorProjection[];
    readonly ledgerStartIndex: number;
    readonly valueToSlot: ReadonlyMap<string, string>;
    readonly secretSlots: Readonly<Record<string, string>> | undefined;
  } => {
    finalizePendingAction();
    const binding = options.resolveAttemptBinding();
    return {
      timestampMs: now(),
      startPath: latestSnapshot?.path ?? "/",
      viewport: latestSnapshot?.viewport ?? { width: 390, height: 844 },
      baselineAnchors: latestSnapshot?.anchors ?? [],
      ledgerStartIndex: binding?.ledger?.rootView().length ?? 0,
      valueToSlot: collectKnownSecrets(binding?.env),
      secretSlots: binding?.secretSlots,
    };
  };

  const commitPendingAction = (
    pre: ReturnType<typeof beginActionBeforeCall>,
    verb: SemanticVerb,
  ): void => {
    if (!enabled) return;
    pendingAction = {
      actionIndex: nextActionIndex++,
      timestampMs: pre.timestampMs,
      completedAtMs: now(),
      startPath: pre.startPath,
      viewport: pre.viewport,
      verb,
      baselineAnchors: pre.baselineAnchors,
      ledgerStartIndex: pre.ledgerStartIndex,
    };
  };

  const resolveTargetById = (
    nodeId: string,
    valueToSlot: ReadonlyMap<string, string>,
  ): {
    readonly entry: IndexedNodeEntry | undefined;
    readonly target: SemanticTarget;
  } => {
    const entry = nodeIndexById.get(nodeId);
    if (entry !== undefined) {
      return {
        entry,
        target: buildSemanticTargetFromEntry(entry, options.platform, valueToSlot),
      };
    }
    return {
      entry: undefined,
      target: {
        testId: nodeId,
        ...(options.platform === "ios" || options.platform === "android"
          ? { accessibilityId: nodeId }
          : {}),
      },
    };
  };

  const mapPerformVerb = (
    ref: NodeRef,
    action: LocatorAction,
    pre: ReturnType<typeof beginActionBeforeCall>,
  ): SemanticVerb | undefined => {
    if (ref.id === "root" && action.kind === "swipe") {
      return {
        name: "swipe",
        direction: action.direction,
      };
    }

    const { entry, target } = resolveTargetById(ref.id, pre.valueToSlot);
    const point = centerPointOfTarget(target, pre.viewport);

    switch (action.kind) {
      case "tap": {
        const modifiers = normalizeModifiers(action.modifiers);
        return {
          name: "click",
          target,
          point,
          ...(modifiers !== undefined ? { modifiers } : {}),
        };
      }
      case "doubleTap": {
        const modifiers = normalizeModifiers(action.modifiers);
        return {
          name: "dblclick",
          target,
          point,
          ...(modifiers !== undefined ? { modifiers } : {}),
        };
      }
      case "multiTap": {
        const modifiers = normalizeModifiers(action.modifiers);
        return {
          name: action.count === 2 ? "dblclick" : "click",
          target,
          point,
          ...(modifiers !== undefined ? { modifiers } : {}),
        };
      }
      case "secondaryTap": {
        const modifiers = normalizeModifiers(action.modifiers);
        return {
          name: "contextmenu",
          target,
          point,
          ...(modifiers !== undefined ? { modifiers } : {}),
        };
      }
      case "hover":
        return {
          name: "hover",
          target,
          point,
        };
      case "longPress":
        return {
          name: "longPress",
          target,
          point,
          durationMs: action.durationMs ?? DEFAULT_LONG_PRESS_DURATION_MS,
        };
      case "fill": {
        const capturedValue = resolveCapturedInputValue({
          rawValue: action.value,
          sensitive: action.sensitive,
          entry,
          valueToSlot: pre.valueToSlot,
          secretSlots: pre.secretSlots,
        });
        const cleanTarget: SemanticTarget =
          capturedValue.kind === "secret"
            ? (({ value: _dropVal, text: _dropText, ...rest }) => rest)(target)
            : target;
        return {
          name: "fill",
          target: cleanTarget,
          value: capturedValue,
          replace: true,
        };
      }
      case "clear":
        return {
          name: "fill",
          target,
          value: resolveCapturedInputValue({
            rawValue: "",
            sensitive: isSecureNode(entry?.node),
            entry,
            valueToSlot: pre.valueToSlot,
            secretSlots: pre.secretSlots,
          }),
          replace: true,
        };
      case "check":
      case "uncheck":
        return {
          name: "check",
          target,
          checked: action.kind === "check",
        };
      case "press": {
        const parsed = parseKey(action.key);
        const keyName =
          parsed === undefined
            ? action.key
            : parsed.key.kind === "named"
              ? parsed.key.name
              : parsed.key.char;
        const modifiers = normalizeModifiers(parsed?.modifiers);
        return {
          name: "press",
          target,
          key: keyName,
          ...(modifiers !== undefined ? { modifiers } : {}),
        };
      }
      case "selectOption": {
        const rawOption =
          typeof action.value === "string"
            ? action.value
            : "label" in action.value && typeof action.value.label === "string"
              ? action.value.label
              : "value" in action.value && typeof action.value.value === "string"
                ? action.value.value
                : String(action.value.index);
        const optionLabel =
          typeof action.value === "object" &&
          "label" in action.value &&
          typeof action.value.label === "string"
            ? action.value.label
            : typeof action.value === "string"
              ? action.value
              : undefined;
        return {
          name: "select",
          target,
          value: resolveCapturedInputValue({
            rawValue: rawOption,
            sensitive: false,
            entry,
            valueToSlot: pre.valueToSlot,
            secretSlots: pre.secretSlots,
          }),
          ...(optionLabel !== undefined ? { optionLabel } : {}),
        };
      }
      case "setInputFiles":
        return {
          name: "upload",
          target,
          fileNames: action.paths.map((p) => p.split(/[\\/]/).pop() ?? p),
          mimeTypes: action.paths.map(() => "application/octet-stream"),
        };
      case "dragTo": {
        const destination = resolveTargetById(action.target.id, pre.valueToSlot).target;
        return {
          name: "drag",
          source: target,
          destination,
        };
      }
      case "swipe": {
        const distanceRatio =
          action.momentum === "fast" ? 0.8 : action.momentum === "slow" ? 0.25 : 0.5;
        return {
          name: "swipe",
          direction: action.direction,
          target,
          distanceRatio,
        };
      }
      case "focus":
      case "blur":
      case "scrollIntoView":
        return undefined;
      case "setInputFilePayloads":
        return {
          name: "upload",
          target,
          fileNames: action.files.map((file) => file.name.split(/[\\/]/).pop() ?? file.name),
          mimeTypes: action.files.map((file) => file.mimeType),
        };
      default: {
        const _exhaustive: never = action;
        return _exhaustive;
      }
    }
  };

  const mapPerformAtVerb = (
    point: ViewportPoint,
    action: PointerAction,
    pre: ReturnType<typeof beginActionBeforeCall>,
  ): SemanticVerb => {
    const roundedPoint = { x: Math.round(point.x), y: Math.round(point.y) };
    const hit = latestSnapshot ? hitTestPoint(point, latestSnapshot.allEntries) : undefined;
    const hitTarget: SemanticTarget =
      hit !== undefined
        ? buildSemanticTargetFromEntry(hit, options.platform, pre.valueToSlot)
        : {
            rect: {
              x: roundedPoint.x,
              y: roundedPoint.y,
              width: 1,
              height: 1,
            },
          };

    switch (action.kind) {
      case "tap":
        return { name: "click", target: hitTarget, point: roundedPoint };
      case "doubleTap":
        return { name: "dblclick", target: hitTarget, point: roundedPoint };
      case "secondaryTap":
        return { name: "contextmenu", target: hitTarget, point: roundedPoint };
      case "hover":
        return { name: "hover", target: hitTarget, point: roundedPoint };
      case "longPress":
        return {
          name: "longPress",
          target: hitTarget,
          point: roundedPoint,
          durationMs: action.durationMs ?? DEFAULT_LONG_PRESS_DURATION_MS,
        };
      case "swipe":
        return {
          name: "swipe",
          direction: action.direction,
          ...(hit !== undefined ? { target: hitTarget } : {}),
        };
      case "swipeTo": {
        const computed = computeSwipeFromPoints(point, action.target, pre.viewport);
        return {
          name: "swipe",
          direction: computed.direction,
          ...(hit !== undefined ? { target: hitTarget } : {}),
          distanceRatio: computed.distanceRatio,
        };
      }
      case "dragTo": {
        const destHit = latestSnapshot
          ? hitTestPoint(action.target, latestSnapshot.allEntries)
          : undefined;
        const destTarget: SemanticTarget =
          destHit !== undefined
            ? buildSemanticTargetFromEntry(destHit, options.platform, pre.valueToSlot)
            : {
                rect: {
                  x: Math.round(action.target.x),
                  y: Math.round(action.target.y),
                  width: 1,
                  height: 1,
                },
              };
        return {
          name: "drag",
          source: hitTarget,
          destination: destTarget,
        };
      }
      default: {
        const _exhaustive: never = action;
        return _exhaustive;
      }
    }
  };

  let inBackHook = false;
  let inOpenLinkHook = false;
  let inDismissKeyboardHook = false;

  const wrappedFixtures: Record<string, (context: EngineFixtureContext) => object> = {};
  for (const [fixtureName, factory] of Object.entries(base.fixtures ?? {})) {
    if (fixtureName === "device") {
      wrappedFixtures[fixtureName] = (context: EngineFixtureContext): object => {
        const proxyContext: EngineFixtureContext = {
          ...context,
          get signal() {
            return context.signal;
          },
          fixture(name, surface, operations) {
            if (name === "device") {
              const proxiedSurface = new Proxy(surface, {
                get(target, prop, receiver) {
                  const raw: unknown = Reflect.get(target, prop, receiver);
                  if (prop === "back" && typeof raw === "function") {
                    return async () => {
                      if (inBackHook) {
                        return await Reflect.apply(raw, target, []);
                      }
                      inBackHook = true;
                      const pre = beginActionBeforeCall();
                      try {
                        const result: unknown = await Reflect.apply(raw, target, []);
                        commitPendingAction(pre, { name: "back" });
                        return result;
                      } finally {
                        inBackHook = false;
                      }
                    };
                  }
                  if (prop === "openLink" && typeof raw === "function") {
                    return async (url: string, linkOptions?: { app?: string }) => {
                      const callArgs =
                        linkOptions === undefined ? [url] : [url, linkOptions];
                      if (inOpenLinkHook) {
                        return await Reflect.apply(raw, target, callArgs);
                      }
                      inOpenLinkHook = true;
                      const pre = beginActionBeforeCall();
                      try {
                        const result: unknown = await Reflect.apply(
                          raw,
                          target,
                          callArgs,
                        );
                        commitPendingAction(pre, {
                          name: "openLink",
                          url: scrubSecretsInString(url, pre.valueToSlot),
                        });
                        return result;
                      } finally {
                        inOpenLinkHook = false;
                      }
                    };
                  }
                  if (prop === "dismissKeyboard" && typeof raw === "function") {
                    return async () => {
                      if (inDismissKeyboardHook) {
                        return await Reflect.apply(raw, target, []);
                      }
                      inDismissKeyboardHook = true;
                      const pre = beginActionBeforeCall();
                      try {
                        const result: unknown = await Reflect.apply(raw, target, []);
                        commitPendingAction(pre, { name: "dismissKeyboard" });
                        return result;
                      } finally {
                        inDismissKeyboardHook = false;
                      }
                    };
                  }
                  return typeof raw === "function" ? raw.bind(target) : raw;
                },
              });
              return context.fixture(name, proxiedSurface, operations);
            }
            return context.fixture(name, surface, operations);
          },
        };
        return factory(proxyContext);
      };
    } else {
      wrappedFixtures[fixtureName] = factory;
    }
  }

  const wrappedSpec = {
    name: base.name,
    version: base.version,
    spiVersion: base.spiVersion,
    ...(base.platform === undefined ? {} : { platform: base.platform }),
    ...(base.workers === undefined ? {} : { workers: base.workers }),
    ...(base.secrets === undefined ? {} : { secrets: base.secrets }),
    ...(base.prepare === undefined ? {} : { prepare: (info: Parameters<NonNullable<typeof base.prepare>>[0]) => base.prepare!(info) }),
    ...(base.finish === undefined ? {} : { finish: (info: Parameters<NonNullable<typeof base.finish>>[0]) => base.finish!(info) }),
    ...(base.doctor === undefined ? {} : { doctor: (info: Parameters<NonNullable<typeof base.doctor>>[0]) => base.doctor!(info) }),
    ...(base.init === undefined ? {} : { init: (info: Parameters<NonNullable<typeof base.init>>[0]) => base.init!(info) }),
    startAttempt: async (context: EngineAttemptContext) => {
      resetAttemptState();
      const wrappedAttemptContext: EngineAttemptContext = {
        ...context,
        ...(context.screen === undefined
          ? {}
          : {
              screen: (snapshot: EngineSnapshot) => {
                ingestSnapshot(snapshot);
                context.screen?.(snapshot);
              },
            }),
      };
      await base.startAttempt?.(wrappedAttemptContext);
    },
    ...(base.settleAttempt === undefined
      ? {}
      : {
          settleAttempt: async (context: EngineCleanupContext) => {
            await base.settleAttempt!(context);
            await flushExportQueue(context.signal);
          },
        }),
    endAttempt: async (context: EngineCleanupContext) => {
      try {
        await flushExportQueue(context.signal);
      } finally {
        try {
          await base.endAttempt?.(context);
        } finally {
          resetAttemptState();
        }
      }
    },
    ...(base.dispose === undefined ? {} : { dispose: (context: Parameters<NonNullable<typeof base.dispose>>[0]) => base.dispose!(context) }),
    ...(base.observe === undefined
      ? {}
      : {
          observe: async (
            operation: OperationContext,
            observeOptions?: EngineObserveOptions,
          ): Promise<EngineSnapshot> => {
            const snapshot = await base.observe!(operation, observeOptions);
            ingestSnapshot(snapshot);
            return snapshot;
          },
        }),
    ...(base.readStyle === undefined
      ? {}
      : {
          readStyle: (
            ref: NodeRef,
            properties: Parameters<NonNullable<typeof base.readStyle>>[1],
            operation: OperationContext,
          ) => base.readStyle!(ref, properties, operation),
        }),
    ...(base.locate === undefined
      ? {}
      : {
          locate: async (
            expression: LocatorExpression,
            operation: OperationContext,
          ): Promise<readonly SemanticNode[]> => {
            const matches = await base.locate!(expression, operation);
            if (enabled) {
              for (const node of matches) {
                if (!nodeIndexById.has(node.ref.id)) {
                  nodeIndexById.set(node.ref.id, { node });
                }
              }
            }
            return matches;
          },
        }),
    ...(base.perform === undefined
      ? {}
      : {
          perform: async (
            ref: NodeRef,
            action: LocatorAction,
            operation: OperationContext,
          ): Promise<void> => {
            if (!enabled) {
              await base.perform!(ref, action, operation);
              return;
            }
            const pre = beginActionBeforeCall();
            const verb = mapPerformVerb(ref, action, pre);
            await base.perform!(ref, action, operation);
            if (verb !== undefined) {
              commitPendingAction(pre, verb);
            }
          },
        }),
    ...(base.actions === undefined ? {} : { actions: base.actions }),
    ...(base.tapModifiers === undefined ? {} : { tapModifiers: base.tapModifiers }),
    ...(base.performAt === undefined
      ? {}
      : {
          performAt: async (
            point: ViewportPoint,
            action: PointerAction,
            operation: OperationContext,
          ): Promise<void> => {
            if (!enabled) {
              await base.performAt!(point, action, operation);
              return;
            }
            const pre = beginActionBeforeCall();
            const verb = mapPerformAtVerb(point, action, pre);
            await base.performAt!(point, action, operation);
            commitPendingAction(pre, verb);
          },
        }),
    ...(base.pointerActions === undefined ? {} : { pointerActions: base.pointerActions }),
    ...(base.keyboard === undefined
      ? {}
      : {
          keyboard: {
            type: async (
              text: string,
              keyboardOptions: { readonly replace: boolean },
              operation: OperationContext,
            ): Promise<void> => {
              if (!enabled) {
                await base.keyboard!.type(text, keyboardOptions, operation);
                return;
              }
              const pre = beginActionBeforeCall();
              const focusedEntry = latestSnapshot?.focusedNode;
              const target: SemanticTarget =
                focusedEntry !== undefined
                  ? buildSemanticTargetFromEntry(
                      focusedEntry,
                      options.platform,
                      pre.valueToSlot,
                    )
                  : { role: "textbox" };
              const capturedValue = resolveCapturedInputValue({
                rawValue: text,
                sensitive: isSecureNode(focusedEntry?.node),
                entry: focusedEntry,
                valueToSlot: pre.valueToSlot,
                secretSlots: pre.secretSlots,
              });
              await base.keyboard!.type(text, keyboardOptions, operation);
              commitPendingAction(pre, {
                name: "fill",
                target,
                value: capturedValue,
                replace: keyboardOptions.replace,
              });
            },
            press: async (key: string, operation: OperationContext): Promise<void> => {
              if (!enabled) {
                await base.keyboard!.press(key, operation);
                return;
              }
              const pre = beginActionBeforeCall();
              const focusedEntry = latestSnapshot?.focusedNode;
              const target =
                focusedEntry !== undefined
                  ? buildSemanticTargetFromEntry(
                      focusedEntry,
                      options.platform,
                      pre.valueToSlot,
                    )
                  : undefined;
              const parsed = parseKey(key);
              const keyName =
                parsed === undefined
                  ? key
                  : parsed.key.kind === "named"
                    ? parsed.key.name
                    : parsed.key.char;
              const modifiers = normalizeModifiers(parsed?.modifiers);
              await base.keyboard!.press(key, operation);
              commitPendingAction(pre, {
                name: "press",
                ...(target !== undefined ? { target } : {}),
                key: keyName,
                ...(modifiers !== undefined ? { modifiers } : {}),
              });
            },
            ...(base.keyboard.dismiss === undefined
              ? {}
              : {
                  dismiss: async (operation: OperationContext): Promise<void> => {
                    if (!enabled || inDismissKeyboardHook) {
                      await base.keyboard!.dismiss!(operation);
                      return;
                    }
                    inDismissKeyboardHook = true;
                    const pre = beginActionBeforeCall();
                    try {
                      await base.keyboard!.dismiss!(operation);
                      commitPendingAction(pre, { name: "dismissKeyboard" });
                    } finally {
                      inDismissKeyboardHook = false;
                    }
                  },
                }),
          },
        }),
    ...(base.validateApp === undefined
      ? {}
      : {
          validateApp: (
            app: Parameters<NonNullable<typeof base.validateApp>>[0],
            info: Parameters<NonNullable<typeof base.validateApp>>[1],
          ) => base.validateApp!(app, info),
        }),
    ...(base.session === undefined
      ? {}
      : {
          session: {
            ...base.session,
            ...(base.session.back === undefined
              ? {}
              : {
                  back: async (operation: OperationContext): Promise<void> => {
                    if (!enabled || inBackHook) {
                      await base.session!.back!(operation);
                      return;
                    }
                    inBackHook = true;
                    const pre = beginActionBeforeCall();
                    try {
                      await base.session!.back!(operation);
                      commitPendingAction(pre, { name: "back" });
                    } finally {
                      inBackHook = false;
                    }
                  },
                }),
            ...(base.session.openLink === undefined
              ? {}
              : {
                  openLink: async (url: string, operation: OperationContext): Promise<void> => {
                    if (!enabled || inOpenLinkHook) {
                      await base.session!.openLink!(url, operation);
                      return;
                    }
                    inOpenLinkHook = true;
                    const pre = beginActionBeforeCall();
                    try {
                      await base.session!.openLink!(url, operation);
                      commitPendingAction(pre, {
                        name: "openLink",
                        url: scrubSecretsInString(url, pre.valueToSlot),
                      });
                    } finally {
                      inOpenLinkHook = false;
                    }
                  },
                }),
          },
        }),
    ...(base.artifacts === undefined ? {} : { artifacts: base.artifacts }),
    ...(base.state === undefined ? {} : { state: base.state }),
    ...(base.isolation === undefined ? {} : { isolation: base.isolation }),
    ...(Object.keys(wrappedFixtures).length === 0 ? {} : { fixtures: wrappedFixtures }),
  };

  const engine = defineEngine<Fixtures>(
    wrappedSpec as unknown as Parameters<typeof defineEngine<Fixtures>>[0],
  );

  const exporter: HostActionExporterController = {
    recordResponseStatus(spanId: string, status: number): void {
      statusBySpanId.set(spanId, status);
    },
    async recordBackAction(): Promise<void> {
      const pre = beginActionBeforeCall();
      commitPendingAction(pre, { name: "back" });
    },
    async recordOpenLinkAction(url: string): Promise<void> {
      const pre = beginActionBeforeCall();
      commitPendingAction(pre, {
        name: "openLink",
        url: scrubSecretsInString(url, pre.valueToSlot),
      });
    },
    async recordDismissKeyboardAction(): Promise<void> {
      const pre = beginActionBeforeCall();
      commitPendingAction(pre, { name: "dismissKeyboard" });
    },
    getRecordedActions(): readonly RecordedSemanticAction[] {
      return [...recordedHistory];
    },
    async flush(signal?: AbortSignal): Promise<void> {
      await flushExportQueue(signal);
    },
    resetAttempt(): void {
      resetAttemptState();
    },
  };

  return { engine, exporter };
}
