import { SpanStatusCode, type Tracer } from "@opentelemetry/api";
import { record as rrwebRecord } from "rrweb";
import type {
  CapturedInputValue,
  CausedHttpTrace,
  InputCaptureMode,
  RecordedSemanticAction,
  SemanticAnchorState,
  SemanticModifierKey,
  SemanticTarget,
  SemanticVerb,
} from "./types.js";

const UI_ACTION_SPAN_NAME = "softprobe.ui.action";
const UI_ACTION_SCHEMA = "sp-ui-action-1" as const;
const MAX_SUMMARY_CHARS = 300;
const MAX_DESCRIPTOR_CHARS = 300;
const MAX_WITHIN_CHARS = 80;
const MAX_ANCHORS = 8;
const MAX_POSITION_TWINS = 1000;
const FILL_IDLE_FLUSH_MS = 600;
const ACTION_QUIET_SETTLE_MS = 40;
const ACTION_MAX_HTTP_SETTLE_MS = 1500;
const SCROLL_DEBOUNCE_MS = 180;
const RESIZE_DEBOUNCE_MS = 180;

const ARIA_ROLES = new Set([
  "alert", "alertdialog", "application", "article", "banner", "blockquote", "button", "caption",
  "cell", "checkbox", "code", "columnheader", "combobox", "complementary", "contentinfo", "definition",
  "deletion", "dialog", "directory", "document", "emphasis", "feed", "figure", "form",
  "generic", "grid", "gridcell", "group", "heading", "img", "insertion", "link",
  "list", "listbox", "listitem", "log", "main", "mark", "marquee", "math",
  "meter", "menu", "menubar", "menuitem", "menuitemcheckbox", "menuitemradio", "navigation", "none",
  "note", "option", "paragraph", "presentation", "progressbar", "radio", "radiogroup", "region",
  "row", "rowgroup", "rowheader", "scrollbar", "search", "searchbox", "separator", "slider",
  "spinbutton", "status", "strong", "subscript", "superscript", "switch", "tab", "table",
  "tablist", "tabpanel", "term", "textbox", "time", "timer", "toolbar", "tooltip",
  "tree", "treegrid", "treeitem",
]);

const CONTAINER_ROLES = new Set([
  "row", "listitem", "article", "group", "region", "dialog", "tabpanel",
]);

const ANNOUNCEMENT_ROLES = new Set(["alert", "alertdialog", "status"]);
const ALERT_ROLES = new Set(["alert", "alertdialog"]);

const ANCHOR_OBSERVABLE_ROLES = new Set([
  "alert", "alertdialog", "status", "dialog", "heading", "button", "link",
  "option", "row", "cell", "listitem", "textbox", "searchbox", "checkbox",
  "radio", "switch", "combobox", "listbox", "tab", "spinbutton",
]);

const NAME_FROM_CONTENT_ROLES = new Set([
  "button", "cell", "checkbox", "columnheader", "gridcell", "heading", "link",
  "menuitem", "menuitemcheckbox", "menuitemradio", "option", "radio", "row",
  "rowheader", "switch", "tab", "tooltip", "treeitem", "listitem", "status", "alert",
]);

const PLACEHOLDER_NAMED_INPUT_TYPES = new Set([
  "text", "password", "number", "search", "tel", "email", "url",
]);

const NON_FILLABLE_INPUT_TYPES = new Set([
  "button", "submit", "reset", "image", "checkbox", "radio", "file", "hidden", "range", "color",
]);

const CAPTURED_NAVIGATION_KEYS = new Set([
  "Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
]);

const MODIFIER_KEY_NAMES = new Set(["Alt", "Control", "Meta", "Shift"]);

const VOLATILE_TEXT_PATTERNS = [
  /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?/,
  /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{12,}\b/,
  /\b\d+\s*(?:ms|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|weeks?|months?|years?)\b/i,
  /\b\d{4}-\d{2}-\d{2}\b/,
  /\b\d{1,2}:\d{2}(?::\d{2})?(?=\b|[ap]\.?m\b)/i,
];

const MINTED_ID_PART = [
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^(?=.*\d)(?=.*[a-f])[0-9a-f]{8,}$/i,
  /^(?=(?:\D*\d){2})(?=.*[A-Za-z])[A-Za-z0-9]{10,}$/,
];

interface AnchorProjection {
  readonly target: SemanticTarget;
  readonly key: string;
  readonly leaf: boolean;
}

interface PendingFillBuffer {
  readonly element: Element;
  readonly target: SemanticTarget;
  readonly startPath: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly baselineAnchors: readonly AnchorProjection[];
  readonly startedAtMs: number;
  readonly initialValue: string;
  currentValue: string;
  timer: ReturnType<typeof setTimeout> | null;
}

interface PendingScrollBuffer {
  readonly target: SemanticTarget | undefined;
  readonly targetKey: string;
  readonly direction: "up" | "down" | "left" | "right";
  readonly startPath: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly baselineAnchors: readonly AnchorProjection[];
  readonly startedAtMs: number;
  readonly spansViewport: number;
  times: number;
  timer: ReturnType<typeof setTimeout> | null;
}

interface SettlingAction {
  readonly actionIndex: number;
  readonly timestampMs: number;
  readonly startPath: string;
  endPath: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly verb: SemanticVerb;
  readonly baselineAnchors: readonly AnchorProjection[];
  readonly causedTraces: CausedHttpTrace[];
  readonly inFlightSpanIds: Set<string>;
  quietTimer: ReturnType<typeof setTimeout> | null;
  maxTimer: ReturnType<typeof setTimeout> | null;
}

export interface SemanticActionRecorderOptions {
  readonly getTracer: () => Tracer | undefined;
  readonly isRrwebActive: () => boolean;
  readonly inputCapture: InputCaptureMode;
  readonly secretSlots?: Readonly<Record<string, string>>;
}

export interface SemanticActionRecorder {
  onHttpSpanStart(info: { readonly traceId: string; readonly spanId: string }): void;
  onHttpSpan(info: CausedHttpTrace): void;
  flush(): void;
  hasPendingWork(): boolean;
  stop(): void;
}

function collapseText(raw: string): string {
  return raw.replace(/\p{Co}/gu, " ").replace(/\s+/g, " ").trim();
}

function boundText(raw: string, maxChars: number): string {
  if (raw.length <= maxChars) return raw;
  return raw.slice(0, maxChars);
}

function squashText(raw: string): string {
  return collapseText(raw).toLowerCase();
}

function roundFraction(value: number): number {
  const clamped = Math.min(1, Math.max(0, value));
  return Math.round(clamped * 10_000) / 10_000;
}

function currentLocationPath(win: Window): string {
  try {
    return `${win.location.pathname || "/"}${win.location.search || ""}`;
  } catch {
    return "/";
  }
}

function formatSameOriginOrUrl(rawUrl: string, win: Window): string {
  try {
    const parsed = new URL(rawUrl, win.location.href);
    if (parsed.origin === win.location.origin) {
      return `${parsed.pathname || "/"}${parsed.search || ""}`;
    }
    return parsed.href;
  } catch {
    return rawUrl;
  }
}

function currentViewport(win: Window): { readonly width: number; readonly height: number } {
  const width = Math.max(1, Math.trunc(win.innerWidth || win.document.documentElement?.clientWidth || 1280));
  const height = Math.max(1, Math.trunc(win.innerHeight || win.document.documentElement?.clientHeight || 720));
  return { width, height };
}

function documentHasMeasuredLayout(doc: Document): boolean {
  const rootRect = doc.documentElement?.getBoundingClientRect();
  if (rootRect && (rootRect.width > 0 || rootRect.height > 0)) return true;
  const bodyRect = doc.body?.getBoundingClientRect();
  return Boolean(bodyRect && (bodyRect.width > 0 || bodyRect.height > 0));
}

function isInClosedDetails(el: Element): boolean {
  let current: Element | null = el;
  while (current) {
    const parent: Element | null = current.parentElement;
    if (
      parent &&
      parent.tagName.toLowerCase() === "details" &&
      !parent.hasAttribute("open")
    ) {
      const firstSummary = Array.from(parent.children).find(
        (child: Element) => child.tagName.toLowerCase() === "summary",
      );
      if (firstSummary !== current && !(firstSummary && firstSummary.contains(el))) {
        return true;
      }
    }
    current = parent;
  }
  return false;
}

export function isElementVisible(el: Element, hasLayout?: boolean): boolean {
  if (el.tagName.toLowerCase() === "input" && (el.getAttribute("type") ?? "").toLowerCase() === "hidden") {
    return false;
  }
  if (el.closest("[hidden], [inert], [aria-hidden='true' i]") !== null) {
    return false;
  }
  if (isInClosedDetails(el)) {
    return false;
  }
  const win = el.ownerDocument.defaultView;
  const style = win?.getComputedStyle(el);
  if (style) {
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") {
      return false;
    }
    if (style.getPropertyValue("content-visibility") === "hidden") {
      return false;
    }
  }
  const checkLayout = hasLayout ?? documentHasMeasuredLayout(el.ownerDocument);
  if (!checkLayout) {
    return true;
  }
  if (style?.display === "contents") {
    return Array.from(el.children).some((child) => isElementVisible(child, true));
  }
  const rect = el.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) {
    return true;
  }
  if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio") && el.labels) {
    return Array.from(el.labels).some((label) => isElementVisible(label, true));
  }
  return false;
}

function isEditingHost(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName.toLowerCase();
  if (["input", "textarea", "select", "button", "a", "img", "svg", "canvas", "iframe"].includes(tag)) {
    return false;
  }
  const attr = el.getAttribute("contenteditable");
  const editable = el.isContentEditable || attr === "" || attr?.toLowerCase() === "true";
  if (!editable) return false;
  const parent = el.parentElement;
  if (parent instanceof HTMLElement) {
    const parentAttr = parent.getAttribute("contenteditable");
    if (parent.isContentEditable || parentAttr === "" || parentAttr?.toLowerCase() === "true") {
      return false;
    }
  }
  return true;
}

function explicitAriaRole(el: Element): string | null {
  const raw = el.getAttribute("role");
  if (!raw) return null;
  for (const token of raw.split(/\s+/)) {
    const lower = token.toLowerCase();
    if (ARIA_ROLES.has(lower)) {
      return lower === "img" ? "image" : lower;
    }
  }
  return null;
}

function hasOwnAriaOrTitleName(el: Element): boolean {
  return ["aria-label", "aria-labelledby", "title"].some(
    (attr) => (el.getAttribute(attr) ?? "").trim() !== "",
  );
}

export function computeElementRole(el: Element): string | undefined {
  const explicit = explicitAriaRole(el);
  if (explicit !== null && explicit !== "presentation" && explicit !== "none") {
    return explicit;
  }
  if (isEditingHost(el)) return "textbox";

  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case "a":
      return el.hasAttribute("href") ? "link" : undefined;
    case "button":
    case "summary":
      return "button";
    case "select":
      return el instanceof HTMLSelectElement && (el.multiple || el.size > 1)
        ? "listbox"
        : "combobox";
    case "textarea":
      return "textbox";
    case "option":
      return "option";
    case "img":
      return el.getAttribute("alt") === "" && !el.getAttribute("title") ? undefined : "image";
    case "svg":
      return "image";
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return "heading";
    case "dialog":
      return "dialog";
    case "output":
      return "status";
    case "nav":
      return "navigation";
    case "main":
      return "main";
    case "aside":
      return "complementary";
    case "article":
      return "article";
    case "section":
      return hasOwnAriaOrTitleName(el) ? "region" : undefined;
    case "form":
      return hasOwnAriaOrTitleName(el) ? "form" : undefined;
    case "fieldset":
    case "details":
    case "optgroup":
      return "group";
    case "ul":
    case "ol":
    case "menu":
      return "list";
    case "li":
      return "listitem";
    case "table":
      return "table";
    case "tr":
      return "row";
    case "td": {
      const table = el.closest("table");
      const tableRole = table ? explicitAriaRole(table) : null;
      return tableRole === "grid" || tableRole === "treegrid" ? "gridcell" : "cell";
    }
    case "th": {
      const scope = (el.getAttribute("scope") ?? "").toLowerCase();
      return scope === "row" || scope === "rowgroup" ? "rowheader" : "columnheader";
    }
    case "progress":
      return "progressbar";
    case "meter":
      return "meter";
    case "input": {
      const type = (el.getAttribute("type") ?? "text").toLowerCase();
      if (
        el instanceof HTMLInputElement &&
        el.list !== null &&
        ["text", "search", "tel", "url", "email"].includes(type)
      ) {
        return "combobox";
      }
      switch (type) {
        case "button":
        case "submit":
        case "reset":
        case "image":
        case "file":
          return "button";
        case "checkbox":
          return "checkbox";
        case "radio":
          return "radio";
        case "range":
          return "slider";
        case "number":
          return "spinbutton";
        case "search":
          return "searchbox";
        case "hidden":
          return undefined;
        default:
          return "textbox";
      }
    }
    default:
      return undefined;
  }
}

function collectVisibleText(node: Node, excludedControl?: Element): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.nodeValue ?? "";
  }
  if (!(node instanceof Element)) return "";
  if (node === excludedControl) return "";
  const tag = node.tagName.toLowerCase();
  if (["script", "style", "noscript", "template"].includes(tag)) return "";
  if ((node.getAttribute("aria-hidden") ?? "").toLowerCase() === "true") return "";
  const style = node.ownerDocument.defaultView?.getComputedStyle(node);
  if (style && (style.display === "none" || style.visibility === "hidden")) return "";
  if (tag === "img") {
    return node.getAttribute("alt") ?? "";
  }
  if (tag === "svg") {
    const title = Array.from(node.children).find((c) => c.tagName.toLowerCase() === "title");
    return title?.textContent ?? "";
  }
  if (["input", "textarea", "select"].includes(tag)) {
    return "";
  }
  let acc = "";
  for (const child of Array.from(node.childNodes)) {
    const piece = collectVisibleText(child, excludedControl);
    if (piece) {
      acc += acc && !acc.endsWith(" ") && !piece.startsWith(" ") ? ` ${piece}` : piece;
    }
  }
  return acc;
}

function readLabelElementsText(el: Element): string | undefined {
  const labels: Element[] = [];
  if (
    (el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLSelectElement ||
      el instanceof HTMLButtonElement ||
      el instanceof HTMLOutputElement) &&
    el.labels &&
    el.labels.length > 0
  ) {
    labels.push(...Array.from(el.labels));
  } else {
    const id = el.getAttribute("id");
    if (id) {
      const escaped = typeof CSS !== "undefined" && typeof CSS.escape === "function"
        ? CSS.escape(id)
        : id.replace(/["\\]/g, "\\$&");
      try {
        labels.push(...Array.from(el.ownerDocument.querySelectorAll(`label[for="${escaped}"]`)));
      } catch {}
    }
    const wrapping = el.closest("label");
    if (wrapping && !labels.includes(wrapping)) {
      labels.push(wrapping);
    }
  }
  if (labels.length === 0) return undefined;
  const joined = collapseText(labels.map((label) => collectVisibleText(label, el)).join(" "));
  return joined === "" ? undefined : joined;
}

function readAriaLabelledByText(el: Element): string | undefined {
  const ids = (el.getAttribute("aria-labelledby") ?? "").trim();
  if (!ids) return undefined;
  const parts: string[] = [];
  for (const id of ids.split(/\s+/)) {
    const ref = el.ownerDocument.getElementById(id);
    if (!ref) continue;
    const txt = collapseText(ref.textContent ?? "");
    if (txt) parts.push(txt);
  }
  const joined = parts.join(" ").trim();
  return joined === "" ? undefined : joined;
}

function computeAccessibleName(el: Element, role: string | undefined): {
  readonly name?: string;
  readonly label?: string;
} {
  const byRef = readAriaLabelledByText(el);
  if (byRef !== undefined) {
    return { name: byRef, label: byRef };
  }
  const ariaLabel = collapseText(el.getAttribute("aria-label") ?? "");
  if (ariaLabel !== "") {
    return { name: ariaLabel, label: ariaLabel };
  }
  const assocLabel = readLabelElementsText(el);
  if (assocLabel !== undefined) {
    return { name: assocLabel, label: assocLabel };
  }

  const tag = el.tagName.toLowerCase();
  if (tag === "fieldset") {
    const legend = Array.from(el.children).find((c) => c.tagName.toLowerCase() === "legend");
    const txt = legend ? collapseText(collectVisibleText(legend)) : "";
    if (txt) return { name: txt };
  }
  if (tag === "figure") {
    const cap = Array.from(el.children).find((c) => c.tagName.toLowerCase() === "figcaption");
    const txt = cap ? collapseText(collectVisibleText(cap)) : "";
    if (txt) return { name: txt };
  }
  if (tag === "table") {
    const cap = Array.from(el.children).find((c) => c.tagName.toLowerCase() === "caption");
    const txt = cap ? collapseText(collectVisibleText(cap)) : "";
    if (txt) return { name: txt };
  }

  if (el instanceof HTMLInputElement) {
    const type = (el.getAttribute("type") ?? "text").toLowerCase();
    if (type === "submit" || type === "reset" || type === "button") {
      const val = collapseText(el.value);
      if (val) return { name: val };
      if (type === "submit") return { name: "Submit" };
      if (type === "reset") return { name: "Reset" };
    }
    if (type === "image") {
      const alt = collapseText(el.getAttribute("alt") ?? "");
      if (alt) return { name: alt };
    }
    if (PLACEHOLDER_NAMED_INPUT_TYPES.has(type)) {
      const ph = collapseText(el.getAttribute("placeholder") ?? "");
      if (ph) return { name: ph };
    }
  }

  if (el instanceof HTMLTextAreaElement) {
    const ph = collapseText(el.getAttribute("placeholder") ?? "");
    if (ph) return { name: ph };
  }

  if (tag === "img") {
    const alt = collapseText(el.getAttribute("alt") ?? "");
    if (alt) return { name: alt };
  }

  if (role !== undefined && NAME_FROM_CONTENT_ROLES.has(role)) {
    const contentText = collapseText(collectVisibleText(el));
    if (contentText) return { name: contentText };
  }

  const title = collapseText(el.getAttribute("title") ?? "");
  if (title) return { name: title };

  return {};
}

function isBuiltInSecretField(el: Element): { readonly slot: string } | null {
  try {
    if (el.matches('input[type="password" i]')) {
      return { slot: "PASSWORD" };
    }
    const autocomplete = (el.getAttribute("autocomplete") ?? "").trim().toLowerCase();
    if (autocomplete === "current-password" || autocomplete === "new-password") {
      return { slot: "PASSWORD" };
    }
    if (autocomplete.startsWith("cc-")) {
      return { slot: "CARD" };
    }
    if (autocomplete === "one-time-code") {
      return { slot: "OTP" };
    }
    if (el.matches('input[name*="password" i]')) {
      return { slot: "PASSWORD" };
    }
    if (el.matches('input[name*="token" i]')) {
      return { slot: "TOKEN" };
    }
    if (el.matches('input[name*="secret" i]')) {
      return { slot: "SECRET" };
    }
  } catch {}
  return null;
}

export function classifyInputValue(
  el: Element,
  rawValue: string,
  inputCapture: InputCaptureMode,
  secretSlots?: Readonly<Record<string, string>>,
): CapturedInputValue {
  if (secretSlots) {
    for (const [selector, slotName] of Object.entries(secretSlots)) {
      const normalizedSlot = slotName.trim();
      if (!selector.trim() || !normalizedSlot) continue;
      try {
        if (el.matches(selector)) {
          return { kind: "secret", slot: normalizedSlot };
        }
      } catch {}
    }
  }
  if (inputCapture !== "unmasked") {
    const builtin = isBuiltInSecretField(el);
    if (builtin !== null) {
      return { kind: "secret", slot: builtin.slot };
    }
  }
  if (inputCapture === "masked") {
    return { kind: "redacted", length: rawValue.length };
  }
  return { kind: "literal", value: rawValue };
}

function isSecretInputElement(
  el: Element,
  secretSlots?: Readonly<Record<string, string>>,
): boolean {
  if (secretSlots) {
    for (const selector of Object.keys(secretSlots)) {
      if (!selector.trim()) continue;
      try {
        if (el.matches(selector)) return true;
      } catch {}
    }
  }
  return isBuiltInSecretField(el) !== null;
}

function computeInputPurpose(el: Element): string | undefined {
  if (el.matches?.('input[type="password" i]')) return "password";
  const autocomplete = (el.getAttribute("autocomplete") ?? "").trim().toLowerCase();
  if (autocomplete === "current-password" || autocomplete === "new-password") {
    return "password";
  }
  if (autocomplete === "username") {
    return "username";
  }
  if (autocomplete === "one-time-code") {
    return "one-time-code";
  }
  return undefined;
}

function readElementTestId(el: Element): string | undefined {
  for (const attr of ["data-testid", "data-test", "data-cy"]) {
    const val = collapseText(el.getAttribute(attr) ?? "");
    if (val !== "") return boundText(val, MAX_DESCRIPTOR_CHARS);
  }
  return undefined;
}

function isMintedDomId(id: string): boolean {
  if (!id || id.length > 80) return true;
  if (id.startsWith(":r") || id.startsWith("radix-") || id.startsWith("headlessui-")) return true;
  return id
    .split(/[-_:./]+/)
    .some((part) => MINTED_ID_PART.some((pattern) => pattern.test(part)));
}

function computeConciseCssSelector(el: Element): string | undefined {
  const doc = el.ownerDocument;
  for (const attr of ["data-testid", "data-test", "data-cy", "name"]) {
    const val = el.getAttribute(attr);
    if (!val) continue;
    const selector = `${el.tagName.toLowerCase()}[${attr}="${val.replace(/["\\]/g, "\\$&")}"]`;
    try {
      if (doc.querySelectorAll(selector).length === 1) {
        return boundText(selector, MAX_DESCRIPTOR_CHARS);
      }
    } catch {}
  }
  const id = el.getAttribute("id");
  if (id && !isMintedDomId(id)) {
    const escaped = typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? `#${CSS.escape(id)}`
      : `[id="${id.replace(/["\\]/g, "\\$&")}"]`;
    try {
      if (doc.querySelectorAll(escaped).length === 1) {
        return boundText(escaped, MAX_DESCRIPTOR_CHARS);
      }
    } catch {}
  }

  const segments: string[] = [];
  let cursor: Element | null = el;
  while (cursor && cursor.tagName.toLowerCase() !== "html" && cursor.tagName.toLowerCase() !== "body" && segments.length < 5) {
    const tag = cursor.tagName.toLowerCase();
    const cursorId = cursor.getAttribute("id");
    if (cursorId && !isMintedDomId(cursorId)) {
      const escaped = typeof CSS !== "undefined" && typeof CSS.escape === "function"
        ? `#${CSS.escape(cursorId)}`
        : `[id="${cursorId.replace(/["\\]/g, "\\$&")}"]`;
      segments.unshift(escaped);
      break;
    }
    const parent: Element | null = cursor.parentElement;
    if (!parent) {
      segments.unshift(tag);
      break;
    }
    const sameTagSiblings = Array.from(parent.children).filter(
      (sib: Element) => sib.tagName.toLowerCase() === tag,
    );
    if (sameTagSiblings.length === 1) {
      segments.unshift(tag);
    } else {
      const nth = sameTagSiblings.indexOf(cursor) + 1;
      segments.unshift(`${tag}:nth-of-type(${nth})`);
    }
    cursor = parent;
  }
  return segments.length > 0 ? boundText(segments.join(" > "), MAX_DESCRIPTOR_CHARS) : undefined;
}

function firstLeafTextOfContainer(container: Element, hasLayout: boolean): string | undefined {
  for (const child of Array.from(container.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      const direct = collapseText(child.nodeValue ?? "");
      if (direct !== "") return direct;
      continue;
    }
    if (!(child instanceof Element)) continue;
    if (!isElementVisible(child, hasLayout)) continue;
    const tag = child.tagName.toLowerCase();
    if (["script", "style", "noscript", "template", "input", "textarea", "select"].includes(tag)) {
      continue;
    }
    if (child.children.length === 0) {
      const leafTxt = collapseText(collectVisibleText(child));
      if (leafTxt !== "") return leafTxt;
      continue;
    }
    const deeper = firstLeafTextOfContainer(child, hasLayout);
    if (deeper !== undefined) return deeper;
  }
  return undefined;
}

function isNamedAfterTwinBranch(
  container: Element,
  cameFromBranch: Element,
  hasLayout: boolean,
): boolean {
  const branchRole = computeElementRole(cameFromBranch);
  if (!branchRole || !CONTAINER_ROLES.has(branchRole)) return false;
  for (const child of Array.from(container.children)) {
    if (!isElementVisible(child, hasLayout)) continue;
    const hasText = firstLeafTextOfContainer(child, hasLayout) !== undefined;
    if (!hasText) continue;
    return child !== cameFromBranch && computeElementRole(child) === branchRole;
  }
  return false;
}

function computeWithinKey(
  el: Element,
  ownNameOrText: string | undefined,
  hasLayout: boolean,
): { readonly within?: string; readonly containerEl?: Element } {
  const ownSquashed = ownNameOrText ? squashText(ownNameOrText) : "";
  let came: Element = el;
  let cursor: Element | null = el.parentElement;
  while (cursor) {
    const containerRole = computeElementRole(cursor);
    if (containerRole && CONTAINER_ROLES.has(containerRole)) {
      const leafKey = isNamedAfterTwinBranch(cursor, came, hasLayout)
        ? undefined
        : firstLeafTextOfContainer(cursor, hasLayout);
      const containerOwn = computeAccessibleName(cursor, containerRole).name;
      const chosen = leafKey ?? containerOwn;
      const clean = chosen ? boundText(collapseText(chosen), MAX_WITHIN_CHARS) : "";
      if (clean === "" || squashText(clean) === ownSquashed) {
        return {};
      }
      return { within: clean, containerEl: cursor };
    }
    came = cursor;
    cursor = cursor.parentElement;
  }
  return {};
}

function computeStates(el: Element): readonly SemanticAnchorState[] | undefined {
  const states: SemanticAnchorState[] = [];
  let checked: boolean | null = null;
  let selected: boolean | null = null;
  if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
    checked = el.checked;
  } else {
    const ariaChecked = el.getAttribute("aria-checked");
    if (ariaChecked !== null) checked = ariaChecked.toLowerCase() === "true";
  }
  if (el instanceof HTMLOptionElement) {
    selected = el.selected;
  } else {
    const ariaSelected = el.getAttribute("aria-selected");
    if (ariaSelected !== null) selected = ariaSelected.toLowerCase() === "true";
  }
  const expanded = (el.getAttribute("aria-expanded") ?? "").toLowerCase() === "true";
  const pressed = (el.getAttribute("aria-pressed") ?? "").toLowerCase() === "true";

  if (checked === true) states.push("checked");
  if (expanded) states.push("expanded");
  if (pressed) states.push("pressed");
  if (selected === true) states.push("selected");
  return states.length > 0 ? states : undefined;
}

function readNonSecretElementValue(
  el: Element,
  secretSlots?: Readonly<Record<string, string>>,
): string | undefined {
  if (isSecretInputElement(el, secretSlots)) return undefined;
  if (el instanceof HTMLInputElement) {
    const type = (el.getAttribute("type") ?? "text").toLowerCase();
    if (type === "checkbox" || type === "radio" || type === "button" || type === "submit" || type === "reset" || type === "file" || type === "hidden") {
      return undefined;
    }
    const collapsed = collapseText(el.value);
    return collapsed === "" ? undefined : boundText(collapsed, MAX_DESCRIPTOR_CHARS);
  }
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    const collapsed = collapseText(el.value);
    return collapsed === "" ? undefined : boundText(collapsed, MAX_DESCRIPTOR_CHARS);
  }
  if (isEditingHost(el)) {
    const collapsed = collapseText(el.textContent ?? "");
    return collapsed === "" ? undefined : boundText(collapsed, MAX_DESCRIPTOR_CHARS);
  }
  return undefined;
}

function getRrwebNodeId(el: Element): number | undefined {
  try {
    const id = rrwebRecord.mirror?.getId(el);
    return typeof id === "number" && Number.isInteger(id) && id >= 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

interface CoreIdentityFields {
  readonly role?: string;
  readonly name?: string;
  readonly text?: string;
  readonly testId?: string;
  readonly placeholder?: string;
  readonly inputPurpose?: string;
}

function extractCoreIdentity(el: Element): CoreIdentityFields {
  const role = computeElementRole(el);
  const { name } = computeAccessibleName(el, role);
  const testId = readElementTestId(el);
  const rawPlaceholder = collapseText(el.getAttribute("placeholder") ?? "");
  const placeholder = rawPlaceholder === "" ? undefined : boundText(rawPlaceholder, MAX_DESCRIPTOR_CHARS);
  const inputPurpose = computeInputPurpose(el);
  const tag = el.tagName.toLowerCase();
  const rawText = ["input", "textarea", "select"].includes(tag)
    ? ""
    : collapseText(collectVisibleText(el));
  const boundedName = name ? boundText(name, MAX_DESCRIPTOR_CHARS) : undefined;
  const boundedText =
    rawText !== "" && rawText !== boundedName
      ? boundText(rawText, MAX_DESCRIPTOR_CHARS)
      : undefined;

  return {
    ...(role !== undefined ? { role } : {}),
    ...(boundedName !== undefined ? { name: boundedName } : {}),
    ...(boundedText !== undefined ? { text: boundedText } : {}),
    ...(testId !== undefined ? { testId } : {}),
    ...(placeholder !== undefined ? { placeholder } : {}),
    ...(inputPurpose !== undefined ? { inputPurpose } : {}),
  };
}

function isAnonymousIdentity(id: CoreIdentityFields): boolean {
  return (
    id.testId === undefined &&
    id.name === undefined &&
    id.text === undefined &&
    id.placeholder === undefined
  );
}

function matchesTwinIdentity(target: CoreIdentityFields, candidate: CoreIdentityFields): boolean {
  const anonymous = isAnonymousIdentity(target);
  const includeText = target.testId === undefined && target.name === undefined;
  const keys: Array<keyof CoreIdentityFields> = includeText
    ? ["role", "name", "testId", "placeholder", "inputPurpose", "text"]
    : ["role", "name", "testId", "placeholder", "inputPurpose"];
  if (anonymous) {
    return keys.every((key) => candidate[key] === target[key]);
  }
  return keys.every((key) => target[key] === undefined || candidate[key] === target[key]);
}

function computeTwinPosition(
  el: Element,
  identity: CoreIdentityFields,
  within: string | undefined,
  hasLayout: boolean,
): { readonly index: number; readonly of: number } | undefined {
  if (identity.role === undefined && isAnonymousIdentity(identity)) {
    return undefined;
  }
  const doc = el.ownerDocument;
  const root = doc.body ?? doc.documentElement;
  if (!root) return undefined;

  const matches: Element[] = [];
  const all = root.querySelectorAll("*");
  for (const candidate of Array.from(all)) {
    if (!isElementVisible(candidate, hasLayout)) continue;
    const candIdentity = extractCoreIdentity(candidate);
    if (!matchesTwinIdentity(identity, candIdentity)) continue;
    if (within !== undefined) {
      const candWithin = computeWithinKey(
        candidate,
        candIdentity.name ?? candIdentity.text,
        hasLayout,
      ).within;
      if (candWithin !== within) continue;
    }
    matches.push(candidate);
    if (matches.length > MAX_POSITION_TWINS) return undefined;
  }

  const minCount = isAnonymousIdentity(identity) ? 1 : 2;
  if (matches.length < minCount || matches.length > MAX_POSITION_TWINS) {
    return undefined;
  }
  const index = matches.indexOf(el);
  return index >= 0 ? { index, of: matches.length } : undefined;
}

export function describeLiveTarget(
  el: Element,
  options?: {
    readonly point?: { readonly x: number; readonly y: number };
    readonly secretSlots?: Readonly<Record<string, string>>;
    readonly includeGeometry?: boolean;
  },
): SemanticTarget {
  const hasLayout = documentHasMeasuredLayout(el.ownerDocument);
  const role = computeElementRole(el);
  const { name, label } = computeAccessibleName(el, role);
  const testId = readElementTestId(el);
  const rawPlaceholder = collapseText(el.getAttribute("placeholder") ?? "");
  const placeholder = rawPlaceholder === "" ? undefined : boundText(rawPlaceholder, MAX_DESCRIPTOR_CHARS);
  const inputPurpose = computeInputPurpose(el);
  const tag = el.tagName.toLowerCase();
  const rawText = ["input", "textarea", "select"].includes(tag)
    ? ""
    : collapseText(collectVisibleText(el));

  const boundedName = name ? boundText(name, MAX_DESCRIPTOR_CHARS) : undefined;
  const boundedLabel = label ? boundText(label, MAX_DESCRIPTOR_CHARS) : undefined;
  const boundedText =
    rawText !== "" && rawText !== boundedName
      ? boundText(rawText, MAX_DESCRIPTOR_CHARS)
      : undefined;

  const coreIdentity: CoreIdentityFields = {
    ...(role !== undefined ? { role } : {}),
    ...(boundedName !== undefined ? { name: boundedName } : {}),
    ...(boundedText !== undefined ? { text: boundedText } : {}),
    ...(testId !== undefined ? { testId } : {}),
    ...(placeholder !== undefined ? { placeholder } : {}),
    ...(inputPurpose !== undefined ? { inputPurpose } : {}),
  };

  const { within } = computeWithinKey(el, boundedName ?? boundedText, hasLayout);
  const position = computeTwinPosition(el, coreIdentity, within, hasLayout);
  const cssSelector = computeConciseCssSelector(el);
  const states = computeStates(el);
  const value = readNonSecretElementValue(el, options?.secretSlots);
  const rrwebNodeId = getRrwebNodeId(el);

  let rectObj: SemanticTarget["rect"];
  let pointOffsetObj: SemanticTarget["pointOffset"];
  if (options?.includeGeometry !== false) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      rectObj = {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
      };
      if (options?.point) {
        pointOffsetObj = {
          fx: roundFraction((options.point.x - r.x) / r.width),
          fy: roundFraction((options.point.y - r.y) / r.height),
        };
      }
    }
  }

  return {
    ...(testId !== undefined ? { testId } : {}),
    ...(role !== undefined ? { role } : {}),
    ...(boundedName !== undefined ? { name: boundedName } : {}),
    ...(boundedLabel !== undefined ? { label: boundedLabel } : {}),
    ...(placeholder !== undefined ? { placeholder } : {}),
    ...(boundedText !== undefined ? { text: boundedText } : {}),
    ...(inputPurpose !== undefined ? { inputPurpose } : {}),
    ...(cssSelector !== undefined ? { cssSelector } : {}),
    ...(within !== undefined ? { within } : {}),
    ...(position !== undefined ? { position } : {}),
    ...(rectObj !== undefined ? { rect: rectObj } : {}),
    ...(pointOffsetObj !== undefined ? { pointOffset: pointOffsetObj } : {}),
    ...(rrwebNodeId !== undefined ? { rrwebNodeId } : {}),
    ...(states !== undefined ? { states } : {}),
    ...(value !== undefined ? { value } : {}),
  };
}

function anchorKeyOf(target: SemanticTarget): string {
  const statesStr = target.states ? target.states.join(",") : "";
  return JSON.stringify([
    target.role ?? null,
    target.name ?? null,
    target.text ?? null,
    target.testId ?? null,
    target.placeholder ?? null,
    target.inputPurpose ?? null,
    target.value ?? null,
    statesStr,
  ]);
}

function isAnchorRelocatable(target: SemanticTarget): boolean {
  return (
    target.testId !== undefined ||
    target.name !== undefined ||
    target.text !== undefined ||
    target.placeholder !== undefined
  );
}

function isVolatileAnchorTarget(target: SemanticTarget): boolean {
  const texts = [target.name, target.text, target.value].filter(
    (item): item is string => item !== undefined,
  );
  if (
    texts.length === 1 &&
    /^\d+$/.test(texts[0]!) &&
    target.testId === undefined
  ) {
    return true;
  }
  return texts.some((txt) => VOLATILE_TEXT_PATTERNS.some((pattern) => pattern.test(txt)));
}

export function snapshotAnchorProjections(
  doc: Document,
  secretSlots?: Readonly<Record<string, string>>,
): readonly AnchorProjection[] {
  const root = doc.body ?? doc.documentElement;
  if (!root) return [];
  const hasLayout = documentHasMeasuredLayout(doc);
  const projections: AnchorProjection[] = [];
  const elements = root.querySelectorAll("*");

  for (const el of Array.from(elements)) {
    if (!isElementVisible(el, hasLayout)) continue;
    const role = computeElementRole(el);
    if (!role || !ANCHOR_OBSERVABLE_ROLES.has(role)) continue;

    const { name } = computeAccessibleName(el, role);
    const testId = readElementTestId(el);
    const rawPlaceholder = collapseText(el.getAttribute("placeholder") ?? "");
    const placeholder = rawPlaceholder === "" ? undefined : boundText(rawPlaceholder, MAX_DESCRIPTOR_CHARS);
    const inputPurpose = computeInputPurpose(el);
    const tag = el.tagName.toLowerCase();
    const rawText = ["input", "textarea", "select"].includes(tag)
      ? ""
      : collapseText(collectVisibleText(el));
    const boundedName = name ? boundText(name, MAX_DESCRIPTOR_CHARS) : undefined;
    const boundedText =
      rawText !== "" && rawText !== boundedName
        ? boundText(rawText, MAX_DESCRIPTOR_CHARS)
        : undefined;
    const states = computeStates(el);
    const value = readNonSecretElementValue(el, secretSlots);

    const target: SemanticTarget = {
      role,
      ...(boundedName !== undefined ? { name: boundedName } : {}),
      ...(boundedText !== undefined ? { text: boundedText } : {}),
      ...(testId !== undefined ? { testId } : {}),
      ...(placeholder !== undefined ? { placeholder } : {}),
      ...(inputPurpose !== undefined ? { inputPurpose } : {}),
      ...(states !== undefined ? { states } : {}),
      ...(value !== undefined ? { value } : {}),
    };
    if (!isAnchorRelocatable(target)) continue;

    const leaf = !CONTAINER_ROLES.has(role) && el.children.length === 0;
    projections.push({
      target,
      key: anchorKeyOf(target),
      leaf,
    });
  }
  return projections;
}

export function computeAnchorDelta(
  baseline: readonly AnchorProjection[],
  settled: readonly AnchorProjection[],
): {
  readonly endAnchors: readonly SemanticTarget[];
  readonly goneAnchors: readonly SemanticTarget[];
} {
  const baselineKeys = new Set(baseline.map((item) => item.key));
  const settledKeys = new Set(settled.map((item) => item.key));

  const partitionSide = (
    items: readonly AnchorProjection[],
    otherKeys: ReadonlySet<string>,
  ) => {
    const seen = new Set<string>();
    const announcements: AnchorProjection[] = [];
    const leaves: AnchorProjection[] = [];
    const containers: AnchorProjection[] = [];
    for (const item of items) {
      if (seen.has(item.key) || otherKeys.has(item.key)) continue;
      seen.add(item.key);
      const role = item.target.role ?? "";
      if (ANNOUNCEMENT_ROLES.has(role)) {
        announcements.push(item);
      } else if (item.leaf) {
        leaves.push(item);
      } else {
        containers.push(item);
      }
    }
    const ordered = [...announcements, ...leaves, ...containers];
    const stable = ordered.filter(
      (item) =>
        ALERT_ROLES.has(item.target.role ?? "") || !isVolatileAnchorTarget(item.target),
    );
    return { ordered, stable };
  };

  const appeared = partitionSide(settled, baselineKeys);
  const vanished = partitionSide(baseline, settledKeys);
  const hasAnyStable = appeared.stable.length > 0 || vanished.stable.length > 0;

  const endList = (appeared.stable.length > 0 ? appeared.stable : hasAnyStable ? [] : appeared.ordered)
    .slice(0, MAX_ANCHORS)
    .map((item) => item.target);
  const goneList = (vanished.stable.length > 0 ? vanished.stable : hasAnyStable ? [] : vanished.ordered)
    .slice(0, MAX_ANCHORS)
    .map((item) => item.target);

  return { endAnchors: endList, goneAnchors: goneList };
}

function formatTargetSummaryLabel(target: SemanticTarget | undefined): string {
  if (!target) return "the screen";
  const label = target.name ?? target.text ?? target.placeholder ?? target.testId ?? "";
  const role = target.role ?? "element";
  const base = label === "" ? role : `${role} ${JSON.stringify(boundText(label, 40))}`;
  const withWithin = target.within !== undefined
    ? `${base} in ${JSON.stringify(boundText(target.within, 40))}`
    : base;
  return target.position !== undefined
    ? `${withWithin} (${target.position.index + 1} of ${target.position.of})`
    : withWithin;
}

export function formatSemanticActionSummary(verb: SemanticVerb): string {
  const quoteShort = (val: string) => JSON.stringify(boundText(val, 40));
  const raw = (() => {
    switch (verb.name) {
      case "navigate":
        return `navigate to ${quoteShort(verb.url)}`;
      case "click": {
        const base = `tap ${formatTargetSummaryLabel(verb.target)}`;
        return verb.modifiers && verb.modifiers.length > 0
          ? `${base} with ${verb.modifiers.join("+")} held`
          : base;
      }
      case "dblclick":
        return `double-tap ${formatTargetSummaryLabel(verb.target)}`;
      case "contextmenu":
        return `secondary-tap ${formatTargetSummaryLabel(verb.target)}`;
      case "hover":
        return `hover over ${formatTargetSummaryLabel(verb.target)}`;
      case "fill": {
        const where = formatTargetSummaryLabel(verb.target);
        if (verb.value.kind === "secret") {
          return `fill secret ${quoteShort(verb.value.slot)} into ${where}`;
        }
        if (verb.value.kind === "redacted") {
          return `fill ${where} (${verb.value.length} chars redacted)`;
        }
        return `type ${quoteShort(verb.value.value)} into ${where}`;
      }
      case "select": {
        const where = formatTargetSummaryLabel(verb.target);
        if (verb.value.kind === "literal") {
          return `select ${quoteShort(verb.optionLabel ?? verb.value.value)} in ${where}`;
        }
        return `select option in ${where}`;
      }
      case "check":
        return `${verb.checked ? "check" : "uncheck"} ${formatTargetSummaryLabel(verb.target)}`;
      case "press":
        return verb.target
          ? `press ${quoteShort(verb.key)} on ${formatTargetSummaryLabel(verb.target)}`
          : `press ${quoteShort(verb.key)}`;
      case "upload":
        return `upload ${verb.fileNames.map(quoteShort).join(", ")} to ${formatTargetSummaryLabel(verb.target)}`;
      case "drag":
        return `drag ${formatTargetSummaryLabel(verb.source)} to ${formatTargetSummaryLabel(verb.destination)}`;
      case "scroll":
        return verb.target
          ? `scroll ${verb.direction} on ${formatTargetSummaryLabel(verb.target)}`
          : `scroll ${verb.direction}`;
      case "dialog":
        return `${verb.accepted ? "accept" : "dismiss"} ${verb.dialogType} dialog`;
      case "resize":
        return `resize the viewport to ${verb.viewport.width}x${verb.viewport.height}`;
      default: {
        const _exhaustive: never = verb;
        return String(_exhaustive);
      }
    }
  })();
  return boundText(raw, MAX_SUMMARY_CHARS);
}

function extractModifiers(event: MouseEvent | KeyboardEvent): readonly SemanticModifierKey[] | undefined {
  const mods: SemanticModifierKey[] = [];
  if (event.altKey) mods.push("Alt");
  if (event.ctrlKey) mods.push("Control");
  if (event.metaKey) mods.push("Meta");
  if (event.shiftKey) mods.push("Shift");
  return mods.length > 0 ? mods : undefined;
}

const INTERACTIVE_SELECTOR = [
  "button",
  "a[href]",
  "input",
  "textarea",
  "select",
  "option",
  "summary",
  "label",
  "[contenteditable='true']",
  "[contenteditable='']",
  "[role='button']",
  "[role='link']",
  "[role='menuitem']",
  "[role='menuitemcheckbox']",
  "[role='menuitemradio']",
  "[role='option']",
  "[role='tab']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='switch']",
  "[role='combobox']",
  "[role='treeitem']",
  "[onclick]",
  "[tabindex]",
].join(",");

function resolveInteractiveTargetFromEvent(event: Event): Element | null {
  const path = typeof event.composedPath === "function" ? event.composedPath() : [];
  let innermostElement: Element | null = null;
  for (const item of path) {
    if (!(item instanceof Element)) continue;
    const tag = item.tagName.toLowerCase();
    if (tag === "html" || tag === "body") break;
    if (!innermostElement) innermostElement = item;
    if (item.matches(INTERACTIVE_SELECTOR)) {
      if (item.hasAttribute("tabindex") && !item.matches(INTERACTIVE_SELECTOR.replace(",[tabindex]", ""))) {
        const tabVal = Number(item.getAttribute("tabindex"));
        if (Number.isNaN(tabVal) || tabVal < 0) continue;
      }
      return item;
    }
  }
  if (innermostElement) return innermostElement;
  return event.target instanceof Element ? event.target : null;
}

function isFillableElement(el: Element): boolean {
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) {
    const type = (el.getAttribute("type") ?? "text").toLowerCase();
    return !NON_FILLABLE_INPUT_TYPES.has(type);
  }
  return isEditingHost(el);
}

function readEditableRawValue(el: Element): string {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return el.value;
  }
  if (isEditingHost(el)) {
    return el.textContent ?? "";
  }
  return "";
}

function primaryRrwebNodeId(verb: SemanticVerb): number | undefined {
  switch (verb.name) {
    case "click":
    case "dblclick":
    case "contextmenu":
    case "hover":
    case "fill":
    case "select":
    case "check":
    case "upload":
      return verb.target.rrwebNodeId;
    case "press":
    case "scroll":
      return verb.target?.rrwebNodeId;
    case "drag":
      return verb.source.rrwebNodeId;
    case "navigate":
    case "dialog":
    case "resize":
      return undefined;
    default: {
      const _exhaustive: never = verb;
      return _exhaustive;
    }
  }
}

export function createSemanticActionRecorder(
  options: SemanticActionRecorderOptions,
): SemanticActionRecorder {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return {
      onHttpSpanStart: () => undefined,
      onHttpSpan: () => undefined,
      flush: () => undefined,
      hasPendingWork: () => false,
      stop: () => undefined,
    };
  }

  const win = window;
  const doc = document;
  let stopped = false;
  let nextActionIndex = 0;

  let pendingFill: PendingFillBuffer | null = null;
  let pendingScroll: PendingScrollBuffer | null = null;
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  let resizeBaseline: {
    readonly startPath: string;
    readonly baselineAnchors: readonly AnchorProjection[];
    readonly startedAtMs: number;
  } | null = null;
  let settlingAction: SettlingAction | null = null;
  let preInteractionSnapshot: {
    readonly capturedAtMs: number;
    readonly path: string;
    readonly anchors: readonly AnchorProjection[];
  } | null = null;
  let dragSourceElement: Element | null = null;
  let lastFlushedFillInfo: { readonly element: Element; readonly flushedAtMs: number } | null = null;
  let lastClickAtMs = 0;
  let pendingClickRouteFold = false;
  let lastKnownPath = currentLocationPath(win);
  let hoverTimer: ReturnType<typeof setTimeout> | null = null;
  let hoverCandidateElement: Element | null = null;
  const lastCheckedByElement = new WeakMap<HTMLInputElement, { readonly checked: boolean; readonly atMs: number }>();

  const takeCurrentAnchors = (): readonly AnchorProjection[] =>
    snapshotAnchorProjections(doc, options.secretSlots);

  const emitActionRecord = (action: RecordedSemanticAction): void => {
    const tracer = options.getTracer();
    if (!tracer) return;

    const summary = formatSemanticActionSummary(action.verb);
    const rrwebNodeId = primaryRrwebNodeId(action.verb);
    const startTime = new Date(action.timestampMs);
    const endTime = new Date(action.timestampMs + Math.max(0, action.settleMs));

    const span = tracer.startSpan(UI_ACTION_SPAN_NAME, {
      startTime,
      attributes: {
        "sp.observation.type": "ui_action",
        "sp.ui.action.schema": UI_ACTION_SCHEMA,
        "sp.ui.action.index": action.actionIndex,
        "sp.ui.action.verb": action.verb.name,
        "sp.ui.action.summary": summary,
        "sp.ui.action.start_path": action.startPath,
        "sp.ui.action.end_path": action.endPath,
        ...(rrwebNodeId !== undefined ? { "sp.ui.action.rrweb_node_id": rrwebNodeId } : {}),
        "sp.ui.action.payload": JSON.stringify(action),
      },
    });
    try {
      span.setStatus({ code: SpanStatusCode.OK });
    } finally {
      span.end(endTime);
    }

    if (options.isRrwebActive()) {
      try {
        rrwebRecord.addCustomEvent("sp.ui.action", {
          actionIndex: action.actionIndex,
          verb: action.verb.name,
          summary,
          ...(rrwebNodeId !== undefined ? { rrwebNodeId } : {}),
        });
      } catch {}
    }
  };

  const finalizeSettlingAction = (settledAnchorsOverride?: readonly AnchorProjection[]): void => {
    const active = settlingAction;
    if (!active) return;
    settlingAction = null;
    if (active.quietTimer !== null) {
      clearTimeout(active.quietTimer);
      active.quietTimer = null;
    }
    if (active.maxTimer !== null) {
      clearTimeout(active.maxTimer);
      active.maxTimer = null;
    }

    const settledAnchors = settledAnchorsOverride ?? takeCurrentAnchors();
    const { endAnchors, goneAnchors } = computeAnchorDelta(
      active.baselineAnchors,
      settledAnchors,
    );
    const endPath = currentLocationPath(win) || active.endPath;
    const settleMs = Math.max(0, Date.now() - active.timestampMs);

    emitActionRecord({
      schemaVersion: UI_ACTION_SCHEMA,
      actionIndex: active.actionIndex,
      timestampMs: active.timestampMs,
      startPath: active.startPath,
      endPath,
      viewport: active.viewport,
      verb: active.verb,
      causedTraces: [...active.causedTraces],
      endAnchors,
      goneAnchors,
      settleMs,
    });
  };

  const scheduleSettleCheck = (active: SettlingAction): void => {
    if (active.quietTimer !== null) {
      clearTimeout(active.quietTimer);
    }
    active.quietTimer = setTimeout(() => {
      if (settlingAction !== active) return;
      if (active.inFlightSpanIds.size === 0) {
        finalizeSettlingAction();
      }
    }, ACTION_QUIET_SETTLE_MS);
  };

  const beginSettlingAction = (input: {
    readonly verb: SemanticVerb;
    readonly startPath: string;
    readonly viewport: { readonly width: number; readonly height: number };
    readonly baselineAnchors: readonly AnchorProjection[];
    readonly timestampMs?: number;
  }): void => {
    if (stopped) return;
    if (settlingAction !== null) {
      finalizeSettlingAction(input.baselineAnchors);
    }
    const now = input.timestampMs ?? Date.now();
    const entry: SettlingAction = {
      actionIndex: nextActionIndex++,
      timestampMs: now,
      startPath: input.startPath,
      endPath: currentLocationPath(win),
      viewport: input.viewport,
      verb: input.verb,
      baselineAnchors: input.baselineAnchors,
      causedTraces: [],
      inFlightSpanIds: new Set(),
      quietTimer: null,
      maxTimer: null,
    };
    settlingAction = entry;
    scheduleSettleCheck(entry);
    entry.maxTimer = setTimeout(() => {
      if (settlingAction === entry) {
        finalizeSettlingAction();
      }
    }, ACTION_MAX_HTTP_SETTLE_MS);
  };

  const flushPendingFill = (): void => {
    const fill = pendingFill;
    if (!fill) return;
    pendingFill = null;
    if (fill.timer !== null) {
      clearTimeout(fill.timer);
      fill.timer = null;
    }
    if (fill.currentValue === fill.initialValue) {
      return;
    }
    const capturedValue = classifyInputValue(
      fill.element,
      fill.currentValue,
      options.inputCapture,
      options.secretSlots,
    );
    lastFlushedFillInfo = { element: fill.element, flushedAtMs: Date.now() };
    beginSettlingAction({
      verb: {
        name: "fill",
        target: fill.target,
        value: capturedValue,
        replace: true,
      },
      startPath: fill.startPath,
      viewport: fill.viewport,
      baselineAnchors: fill.baselineAnchors,
      timestampMs: fill.startedAtMs,
    });
  };

  const flushPendingScroll = (): void => {
    const scroll = pendingScroll;
    if (!scroll) return;
    pendingScroll = null;
    if (scroll.timer !== null) {
      clearTimeout(scroll.timer);
      scroll.timer = null;
    }
    beginSettlingAction({
      verb: {
        name: "scroll",
        ...(scroll.target !== undefined ? { target: scroll.target } : {}),
        direction: scroll.direction,
        times: scroll.times,
        spansViewport: scroll.spansViewport,
      },
      startPath: scroll.startPath,
      viewport: scroll.viewport,
      baselineAnchors: scroll.baselineAnchors,
      timestampMs: scroll.startedAtMs,
    });
  };

  const flushPendingResize = (): void => {
    if (resizeTimer === null || !resizeBaseline) return;
    clearTimeout(resizeTimer);
    resizeTimer = null;
    const base = resizeBaseline;
    resizeBaseline = null;
    const vp = currentViewport(win);
    beginSettlingAction({
      verb: { name: "resize", viewport: vp },
      startPath: base.startPath,
      viewport: vp,
      baselineAnchors: base.baselineAnchors,
      timestampMs: base.startedAtMs,
    });
  };

  const flushBufferedInputs = (): void => {
    flushPendingScroll();
    flushPendingResize();
    flushPendingFill();
  };

  const resolveFreshBaseline = (): {
    readonly path: string;
    readonly anchors: readonly AnchorProjection[];
  } => {
    const now = Date.now();
    if (preInteractionSnapshot && now - preInteractionSnapshot.capturedAtMs <= 250) {
      return {
        path: preInteractionSnapshot.path,
        anchors: preInteractionSnapshot.anchors,
      };
    }
    return {
      path: currentLocationPath(win),
      anchors: takeCurrentAnchors(),
    };
  };

  const onPointerDown = (): void => {
    if (stopped) return;
    preInteractionSnapshot = {
      capturedAtMs: Date.now(),
      path: currentLocationPath(win),
      anchors: takeCurrentAnchors(),
    };
  };

  const onFocusIn = (event: FocusEvent): void => {
    if (stopped) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (pendingFill && pendingFill.element !== target) {
      flushPendingFill();
    }
    if (isFillableElement(target)) {
      preInteractionSnapshot = {
        capturedAtMs: Date.now(),
        path: currentLocationPath(win),
        anchors: takeCurrentAnchors(),
      };
    }
  };

  const onFocusOut = (event: FocusEvent): void => {
    if (stopped) return;
    if (pendingFill && event.target === pendingFill.element) {
      flushPendingFill();
    }
  };

  const onInput = (event: Event): void => {
    if (stopped) return;
    const rawTarget = event.target;
    if (!(rawTarget instanceof Element) || !isFillableElement(rawTarget)) return;

    const currentValue = readEditableRawValue(rawTarget);
    if (
      currentValue === "" &&
      lastFlushedFillInfo &&
      lastFlushedFillInfo.element === rawTarget &&
      Date.now() - lastFlushedFillInfo.flushedAtMs <= 80 &&
      !(event instanceof InputEvent && event.inputType?.startsWith("delete"))
    ) {
      return;
    }

    if (pendingFill && pendingFill.element !== rawTarget) {
      flushPendingFill();
    }

    if (!pendingFill) {
      const base = resolveFreshBaseline();
      pendingFill = {
        element: rawTarget,
        target: describeLiveTarget(rawTarget, { secretSlots: options.secretSlots }),
        startPath: base.path,
        viewport: currentViewport(win),
        baselineAnchors: base.anchors,
        startedAtMs: Date.now(),
        initialValue: "",
        currentValue,
        timer: null,
      };
    } else {
      pendingFill.currentValue = currentValue;
    }

    if (pendingFill.timer !== null) {
      clearTimeout(pendingFill.timer);
    }
    pendingFill.timer = setTimeout(() => {
      flushPendingFill();
    }, FILL_IDLE_FLUSH_MS);
  };

  const onChange = (event: Event): void => {
    if (stopped) return;
    const el = event.target;
    if (!(el instanceof Element)) return;

    if (el instanceof HTMLSelectElement) {
      flushBufferedInputs();
      const base = resolveFreshBaseline();
      const target = describeLiveTarget(el, { secretSlots: options.secretSlots });
      const selectedOption = el.selectedOptions?.[0];
      const optionLabel = selectedOption ? collapseText(selectedOption.textContent ?? "") : undefined;
      const value = classifyInputValue(
        el,
        el.value,
        options.inputCapture,
        options.secretSlots,
      );
      beginSettlingAction({
        verb: {
          name: "select",
          target,
          value,
          ...(optionLabel ? { optionLabel: boundText(optionLabel, MAX_DESCRIPTOR_CHARS) } : {}),
        },
        startPath: base.path,
        viewport: currentViewport(win),
        baselineAnchors: base.anchors,
      });
      return;
    }

    if (el instanceof HTMLInputElement) {
      const type = (el.getAttribute("type") ?? "text").toLowerCase();
      if (type === "checkbox" || type === "radio") {
        const now = Date.now();
        const prevCheck = lastCheckedByElement.get(el);
        if (prevCheck && prevCheck.checked === el.checked && now - prevCheck.atMs <= 50) {
          return;
        }
        lastCheckedByElement.set(el, { checked: el.checked, atMs: now });
        flushBufferedInputs();
        const base = resolveFreshBaseline();
        const target = describeLiveTarget(el, { secretSlots: options.secretSlots });
        beginSettlingAction({
          verb: {
            name: "check",
            target,
            checked: el.checked,
          },
          startPath: base.path,
          viewport: currentViewport(win),
          baselineAnchors: base.anchors,
        });
        return;
      }

      if (type === "file") {
        flushBufferedInputs();
        const base = resolveFreshBaseline();
        const target = describeLiveTarget(el, { secretSlots: options.secretSlots });
        const files = el.files ? Array.from(el.files) : [];
        beginSettlingAction({
          verb: {
            name: "upload",
            target,
            fileNames: files.map((file) => file.name),
            mimeTypes: files.map((file) => file.type || "application/octet-stream"),
          },
          startPath: base.path,
          viewport: currentViewport(win),
          baselineAnchors: base.anchors,
        });
        return;
      }

      if (isFillableElement(el)) {
        if (pendingFill && pendingFill.element === el) {
          pendingFill.currentValue = el.value;
          flushPendingFill();
        }
      }
    }
  };

  const onSubmit = (): void => {
    if (stopped) return;
    flushBufferedInputs();
  };

  const handleMouseVerb = (
    verbName: "click" | "dblclick" | "contextmenu",
    event: MouseEvent,
  ): void => {
    if (stopped) return;
    const resolved = resolveInteractiveTargetFromEvent(event);
    if (!resolved) return;

    if (verbName === "click") {
      if (resolved instanceof HTMLLabelElement && resolved.control) {
        const ctrl = resolved.control;
        if (ctrl instanceof HTMLInputElement) {
          const ctrlType = (ctrl.getAttribute("type") ?? "text").toLowerCase();
          if (ctrlType === "checkbox" || ctrlType === "radio" || ctrlType === "file" || isFillableElement(ctrl)) {
            return;
          }
        }
        if (ctrl instanceof HTMLTextAreaElement || ctrl instanceof HTMLSelectElement) {
          return;
        }
      }

      if (resolved instanceof HTMLInputElement) {
        const inputType = (resolved.getAttribute("type") ?? "text").toLowerCase();
        if (inputType === "checkbox" || inputType === "radio" || inputType === "file") {
          return;
        }
      }

      const modifiers = extractModifiers(event);
      if (
        !modifiers &&
        (isFillableElement(resolved) || resolved instanceof HTMLSelectElement || resolved instanceof HTMLOptionElement)
      ) {
        if (pendingFill && pendingFill.element !== resolved) {
          flushPendingFill();
        }
        return;
      }

      const customRole = explicitAriaRole(resolved);
      if (
        !(resolved instanceof HTMLInputElement) &&
        (customRole === "checkbox" || customRole === "switch")
      ) {
        flushBufferedInputs();
        const base = resolveFreshBaseline();
        const viewport = currentViewport(win);
        queueMicrotask(() => {
          if (stopped) return;
          const checked = (resolved.getAttribute("aria-checked") ?? "").toLowerCase() === "true";
          const target = describeLiveTarget(resolved, { secretSlots: options.secretSlots });
          beginSettlingAction({
            verb: { name: "check", target, checked },
            startPath: base.path,
            viewport,
            baselineAnchors: base.anchors,
          });
        });
        return;
      }
    }

    flushBufferedInputs();
    lastClickAtMs = Date.now();
    pendingClickRouteFold = verbName === "click";
    const point = {
      x: Math.round(event.clientX || 0),
      y: Math.round(event.clientY || 0),
    };
    const base = resolveFreshBaseline();
    const target = describeLiveTarget(resolved, {
      point,
      secretSlots: options.secretSlots,
    });
    const modifiers = extractModifiers(event);

    beginSettlingAction({
      verb: {
        name: verbName,
        target,
        ...(modifiers !== undefined ? { modifiers } : {}),
        point,
      },
      startPath: base.path,
      viewport: currentViewport(win),
      baselineAnchors: base.anchors,
    });
  };

  const clearPendingHover = (): void => {
    if (hoverTimer !== null) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
    hoverCandidateElement = null;
  };

  const resolveHoverTriggerElement = (start: Element | null): Element | null => {
    let cur: Element | null = start;
    let depth = 0;
    while (cur && depth < 6) {
      const hasPopup = (cur.getAttribute("aria-haspopup") ?? "").trim().toLowerCase();
      if (hasPopup && hasPopup !== "false") return cur;
      const role = explicitAriaRole(cur);
      if (role === "menuitem" || role === "tooltip") return cur;
      if (cur.hasAttribute("aria-describedby")) return cur;
      cur = cur.parentElement;
      depth += 1;
    }
    return null;
  };

  const onPointerOver = (event: MouseEvent): void => {
    if (stopped) return;
    const rawTarget = event.target instanceof Element ? event.target : null;
    const triggerEl = resolveHoverTriggerElement(rawTarget);
    if (!triggerEl) {
      clearPendingHover();
      return;
    }
    if (hoverCandidateElement === triggerEl) return;
    clearPendingHover();
    hoverCandidateElement = triggerEl;
    const point = {
      x: Math.round(event.clientX || 0),
      y: Math.round(event.clientY || 0),
    };
    const modifiers = extractModifiers(event);
    const base = {
      path: currentLocationPath(win),
      anchors: takeCurrentAnchors(),
    };
    hoverTimer = setTimeout(() => {
      hoverTimer = null;
      if (stopped || hoverCandidateElement !== triggerEl || Date.now() - lastClickAtMs < 400) {
        return;
      }
      flushBufferedInputs();
      const target = describeLiveTarget(triggerEl, {
        point,
        secretSlots: options.secretSlots,
      });
      beginSettlingAction({
        verb: {
          name: "hover",
          target,
          ...(modifiers !== undefined ? { modifiers } : {}),
          point,
        },
        startPath: base.path,
        viewport: currentViewport(win),
        baselineAnchors: base.anchors,
      });
    }, 350);
  };

  const onPointerOut = (event: MouseEvent): void => {
    if (!hoverCandidateElement) return;
    const nextTarget = event.relatedTarget instanceof Node ? event.relatedTarget : null;
    if (nextTarget && hoverCandidateElement.contains(nextTarget)) return;
    clearPendingHover();
  };

  const onClick = (event: MouseEvent): void => {
    clearPendingHover();
    handleMouseVerb("click", event);
  };
  const onDblClick = (event: MouseEvent): void => {
    clearPendingHover();
    handleMouseVerb("dblclick", event);
  };
  const onContextMenu = (event: MouseEvent): void => {
    clearPendingHover();
    handleMouseVerb("contextmenu", event);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (stopped) return;
    const key = event.key;
    if (!key || MODIFIER_KEY_NAMES.has(key)) return;

    const hasCommandModifier = event.ctrlKey || event.metaKey || event.altKey;
    const isActionKey = CAPTURED_NAVIGATION_KEYS.has(key) || hasCommandModifier;
    if (!isActionKey) {
      if (!preInteractionSnapshot || Date.now() - preInteractionSnapshot.capturedAtMs > 250) {
        preInteractionSnapshot = {
          capturedAtMs: Date.now(),
          path: currentLocationPath(win),
          anchors: takeCurrentAnchors(),
        };
      }
      return;
    }

    flushBufferedInputs();
    const base = resolveFreshBaseline();
    const targetEl = event.target instanceof Element && event.target !== doc.body && event.target !== doc.documentElement
      ? event.target
      : doc.activeElement instanceof Element && doc.activeElement !== doc.body && doc.activeElement !== doc.documentElement
        ? doc.activeElement
        : null;
    const target = targetEl
      ? describeLiveTarget(targetEl, { secretSlots: options.secretSlots })
      : undefined;
    const modifiers = extractModifiers(event);

    beginSettlingAction({
      verb: {
        name: "press",
        ...(target !== undefined ? { target } : {}),
        key,
        ...(modifiers !== undefined ? { modifiers } : {}),
      },
      startPath: base.path,
      viewport: currentViewport(win),
      baselineAnchors: base.anchors,
    });
  };

  const onDragStart = (event: DragEvent): void => {
    if (stopped) return;
    dragSourceElement = event.target instanceof Element ? event.target : null;
  };

  const onDrop = (event: DragEvent): void => {
    if (stopped) return;
    const destEl = event.target instanceof Element ? event.target : null;
    if (!dragSourceElement || !destEl || dragSourceElement === destEl) {
      dragSourceElement = null;
      return;
    }
    const sourceEl = dragSourceElement;
    dragSourceElement = null;
    flushBufferedInputs();
    const base = resolveFreshBaseline();
    beginSettlingAction({
      verb: {
        name: "drag",
        source: describeLiveTarget(sourceEl, { secretSlots: options.secretSlots }),
        destination: describeLiveTarget(destEl, { secretSlots: options.secretSlots }),
      },
      startPath: base.path,
      viewport: currentViewport(win),
      baselineAnchors: base.anchors,
    });
  };

  let lastScrollPositions = new WeakMap<EventTarget, { readonly top: number; readonly left: number }>();

  const onScroll = (event: Event): void => {
    if (stopped) return;
    const rawTarget = event.target;
    const isDocScroll =
      rawTarget === doc ||
      rawTarget === doc.documentElement ||
      rawTarget === doc.body ||
      rawTarget === win;
    const scrollEl = isDocScroll
      ? doc.scrollingElement ?? doc.documentElement
      : rawTarget instanceof Element
        ? rawTarget
        : null;
    if (!scrollEl) return;

    const currentTop = scrollEl.scrollTop;
    const currentLeft = scrollEl.scrollLeft;
    const prevKey: EventTarget = isDocScroll ? doc : scrollEl;
    const prev = lastScrollPositions.get(prevKey) ?? { top: 0, left: 0 };
    lastScrollPositions.set(prevKey, { top: currentTop, left: currentLeft });

    const dy = currentTop - prev.top;
    const dx = currentLeft - prev.left;
    if (dy === 0 && dx === 0) return;

    const direction: "up" | "down" | "left" | "right" =
      Math.abs(dy) >= Math.abs(dx)
        ? dy >= 0 ? "down" : "up"
        : dx >= 0 ? "right" : "left";

    const vp = currentViewport(win);
    let targetDescriptor: SemanticTarget | undefined;
    let targetKey = "viewport";
    let spansViewport = 1;

    if (!isDocScroll && scrollEl instanceof Element) {
      targetDescriptor = describeLiveTarget(scrollEl, { secretSlots: options.secretSlots });
      targetKey = targetDescriptor.cssSelector ?? targetDescriptor.name ?? scrollEl.tagName;
      const r = scrollEl.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        spansViewport = roundFraction((r.width * r.height) / (vp.width * vp.height));
      }
    }

    if (
      pendingScroll &&
      pendingScroll.targetKey === targetKey &&
      pendingScroll.direction === direction
    ) {
      pendingScroll.times += 1;
      if (pendingScroll.timer !== null) clearTimeout(pendingScroll.timer);
      pendingScroll.timer = setTimeout(flushPendingScroll, SCROLL_DEBOUNCE_MS);
      return;
    }

    flushPendingScroll();
    const base = resolveFreshBaseline();
    pendingScroll = {
      target: targetDescriptor,
      targetKey,
      direction,
      startPath: base.path,
      viewport: vp,
      baselineAnchors: base.anchors,
      startedAtMs: Date.now(),
      spansViewport,
      times: 1,
      timer: setTimeout(flushPendingScroll, SCROLL_DEBOUNCE_MS),
    };
  };

  const onResize = (): void => {
    if (stopped) return;
    if (!resizeBaseline) {
      resizeBaseline = {
        startPath: currentLocationPath(win),
        baselineAnchors: takeCurrentAnchors(),
        startedAtMs: Date.now(),
      };
    }
    if (resizeTimer !== null) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(flushPendingResize, RESIZE_DEBOUNCE_MS);
  };

  const handleNavigationChange = (
    trigger: "pushState" | "popstate",
    previousPath: string,
    targetUrl?: string,
  ): void => {
    if (stopped) return;
    const nextPath = targetUrl ? formatSameOriginOrUrl(targetUrl, win) : currentLocationPath(win);
    lastKnownPath = nextPath;
    if (settlingAction !== null) {
      if (
        pendingClickRouteFold &&
        Date.now() - lastClickAtMs <= 250 &&
        (settlingAction.verb.name === "click" || settlingAction.verb.name === "dialog")
      ) {
        pendingClickRouteFold = false;
        settlingAction.endPath = nextPath;
        return;
      }
    }
    pendingClickRouteFold = false;
    if (nextPath === previousPath) return;

    flushBufferedInputs();
    beginSettlingAction({
      verb: {
        name: "navigate",
        url: nextPath,
        trigger,
      },
      startPath: previousPath,
      viewport: currentViewport(win),
      baselineAnchors: preInteractionSnapshot?.anchors ?? takeCurrentAnchors(),
    });
  };

  const onPopState = (): void => {
    const prev = lastKnownPath;
    handleNavigationChange("popstate", prev);
  };

  const originalPushState = win.history.pushState;
  const originalReplaceState = win.history.replaceState;

  win.history.pushState = function (
    this: History,
    data: unknown,
    unused: string,
    url?: string | URL | null,
  ): void {
    const previousPath = lastKnownPath;
    Reflect.apply(originalPushState, this, [data, unused, url]);
    if (url !== undefined && url !== null) {
      handleNavigationChange("pushState", previousPath, String(url));
    }
  };

  win.history.replaceState = function (
    this: History,
    data: unknown,
    unused: string,
    url?: string | URL | null,
  ): void {
    const previousPath = lastKnownPath;
    Reflect.apply(originalReplaceState, this, [data, unused, url]);
    const currentPath = currentLocationPath(win);
    lastKnownPath = currentPath;
    if (!stopped && settlingAction !== null && url !== undefined && url !== null) {
      settlingAction.endPath = formatSameOriginOrUrl(String(url), win);
    } else if (!stopped && previousPath !== currentPath) {
      preInteractionSnapshot = {
        capturedAtMs: Date.now(),
        path: currentPath,
        anchors: takeCurrentAnchors(),
      };
    }
  };

  const originalAlert = typeof win.alert === "function" ? win.alert : undefined;
  const originalConfirm = typeof win.confirm === "function" ? win.confirm : undefined;
  const originalPrompt = typeof win.prompt === "function" ? win.prompt : undefined;

  if (originalAlert) {
    win.alert = function (this: Window, message?: unknown): void {
      const base = resolveFreshBaseline();
      Reflect.apply(originalAlert, this, [message]);
      if (!stopped) {
        beginSettlingAction({
          verb: { name: "dialog", dialogType: "alert", accepted: true },
          startPath: base.path,
          viewport: currentViewport(win),
          baselineAnchors: base.anchors,
        });
      }
    };
  }

  if (originalConfirm) {
    win.confirm = function (this: Window, message?: string): boolean {
      const base = resolveFreshBaseline();
      const accepted = Boolean(Reflect.apply(originalConfirm, this, [message]));
      if (!stopped) {
        beginSettlingAction({
          verb: { name: "dialog", dialogType: "confirm", accepted },
          startPath: base.path,
          viewport: currentViewport(win),
          baselineAnchors: base.anchors,
        });
      }
      return accepted;
    };
  }

  if (originalPrompt) {
    win.prompt = function (this: Window, message?: string, defaultText?: string): string | null {
      const base = resolveFreshBaseline();
      const answer = originalPrompt.call(this, message, defaultText);
      if (!stopped) {
        const promptValue: CapturedInputValue | undefined =
          answer === null
            ? undefined
            : options.inputCapture === "masked"
              ? { kind: "redacted", length: answer.length }
              : { kind: "literal", value: answer };
        beginSettlingAction({
          verb: {
            name: "dialog",
            dialogType: "prompt",
            accepted: answer !== null,
            ...(promptValue !== undefined ? { promptText: promptValue } : {}),
          },
          startPath: base.path,
          viewport: currentViewport(win),
          baselineAnchors: base.anchors,
        });
      }
      return answer;
    };
  }

  win.addEventListener("pointerdown", onPointerDown, true);
  win.addEventListener("mousedown", onPointerDown, true);
  win.addEventListener("mouseover", onPointerOver, true);
  win.addEventListener("mouseout", onPointerOut, true);
  win.addEventListener("focusin", onFocusIn, true);
  win.addEventListener("focusout", onFocusOut, true);
  win.addEventListener("input", onInput, true);
  win.addEventListener("change", onChange, true);
  win.addEventListener("submit", onSubmit, true);
  win.addEventListener("click", onClick, true);
  win.addEventListener("dblclick", onDblClick, true);
  win.addEventListener("contextmenu", onContextMenu, true);
  win.addEventListener("keydown", onKeyDown, true);
  win.addEventListener("dragstart", onDragStart, true);
  win.addEventListener("drop", onDrop, true);
  win.addEventListener("scroll", onScroll, true);
  win.addEventListener("resize", onResize);
  win.addEventListener("popstate", onPopState);

  return {
    onHttpSpanStart(info): void {
      if (stopped) return;
      if (pendingFill) {
        flushPendingFill();
      }
      if (settlingAction) {
        settlingAction.inFlightSpanIds.add(info.spanId);
      }
    },

    onHttpSpan(info): void {
      if (stopped) return;
      const active = settlingAction;
      if (!active) return;
      if (info.spanId) {
        active.inFlightSpanIds.delete(info.spanId);
      }
      const existingIdx = active.causedTraces.findIndex(
        (entry) =>
          (info.spanId !== undefined && entry.spanId === info.spanId) ||
          (entry.traceId === info.traceId && entry.method === info.method && entry.url === info.url),
      );
      if (existingIdx >= 0) {
        active.causedTraces[existingIdx] = info;
      } else {
        active.causedTraces.push(info);
      }
      scheduleSettleCheck(active);
    },

    flush(): void {
      flushBufferedInputs();
      if (settlingAction !== null) {
        finalizeSettlingAction();
      }
    },

    hasPendingWork(): boolean {
      return (
        pendingFill !== null ||
        pendingScroll !== null ||
        resizeTimer !== null ||
        settlingAction !== null
      );
    },

    stop(): void {
      if (stopped) return;
      clearPendingHover();
      flushBufferedInputs();
      if (settlingAction !== null) {
        finalizeSettlingAction();
      }
      stopped = true;

      win.removeEventListener("pointerdown", onPointerDown, true);
      win.removeEventListener("mousedown", onPointerDown, true);
      win.removeEventListener("mouseover", onPointerOver, true);
      win.removeEventListener("mouseout", onPointerOut, true);
      win.removeEventListener("focusin", onFocusIn, true);
      win.removeEventListener("focusout", onFocusOut, true);
      win.removeEventListener("input", onInput, true);
      win.removeEventListener("change", onChange, true);
      win.removeEventListener("submit", onSubmit, true);
      win.removeEventListener("click", onClick, true);
      win.removeEventListener("dblclick", onDblClick, true);
      win.removeEventListener("contextmenu", onContextMenu, true);
      win.removeEventListener("keydown", onKeyDown, true);
      win.removeEventListener("dragstart", onDragStart, true);
      win.removeEventListener("drop", onDrop, true);
      win.removeEventListener("scroll", onScroll, true);
      win.removeEventListener("resize", onResize);
      win.removeEventListener("popstate", onPopState);

      win.history.pushState = originalPushState;
      win.history.replaceState = originalReplaceState;
      if (originalAlert) win.alert = originalAlert;
      if (originalConfirm) win.confirm = originalConfirm;
      if (originalPrompt) win.prompt = originalPrompt;
    },
  };
}
