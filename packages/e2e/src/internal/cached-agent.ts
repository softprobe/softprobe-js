import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { DefinedTool } from "@e2e-dev/core/agent";
import { AgentError, type AgentConfig, type ModelInstance } from "e2e";
import { z } from "zod";
import { resolveCurrentAttemptMetadata } from "./config.js";
import type { SemanticAnchorState } from "./ui-action-schema.js";

const E2E_TRACE_SCHEMA_VERSION = "trace-1" as const;

export interface SoftprobeCachedAgentOptions {
  readonly model?: ModelInstance;
  readonly judge?: ModelInstance;
  readonly context?: string;
  readonly tools?: Readonly<Record<string, DefinedTool>>;
  readonly cacheDir?: string;
}

interface CachedTargetDescriptor {
  readonly role?: string;
  readonly name?: string;
  readonly text?: string;
  readonly testId?: string;
  readonly placeholder?: string;
  readonly selector?: string;
  readonly inputPurpose?: string;
  readonly within?: string;
  readonly value?: string;
  readonly position?: { readonly index: number; readonly of: number };
  readonly states?: readonly SemanticAnchorState[];
}

const VALID_E2E_INPUT_PURPOSES = new Set(["password", "username", "one-time-code"]);
const CONTENT_NAMED_ANCHOR_ROLES = new Set([
  "alert",
  "alertdialog",
  "status",
  "button",
  "link",
  "heading",
  "option",
  "tab",
  "menuitem",
  "checkbox",
  "radio",
  "switch",
]);

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function compareCodeUnits(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number": {
      if (!Number.isFinite(value)) {
        throw new TypeError("Non-finite number in canonical JSON");
      }
      return JSON.stringify(value);
    }
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
      }
      const entries = Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => compareCodeUnits(a, b));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
    }
    default:
      throw new TypeError(`Unsupported type in canonical JSON: ${typeof value}`);
  }
}

function canonicalDigest(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

function normalizeE2EInstruction(instruction: string): string {
  return instruction.replace(/\r\n?/gu, "\n").normalize("NFC").trim();
}

function boundStr(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed === "") return undefined;
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max);
}

function isTargetAnonymous(desc: CachedTargetDescriptor): boolean {
  return (
    desc.testId === undefined &&
    desc.name === undefined &&
    desc.text === undefined &&
    desc.placeholder === undefined
  );
}

const cachedTargetDescriptorSchema: z.ZodType<CachedTargetDescriptor> = z.object({
  role: z.string().optional(),
  name: z.string().optional(),
  text: z.string().optional(),
  testId: z.string().optional(),
  placeholder: z.string().optional(),
  selector: z.string().optional(),
  inputPurpose: z.string().optional(),
  within: z.string().optional(),
  value: z.string().optional(),
  position: z
    .object({
      index: z.number().int().nonnegative(),
      of: z.number().int().positive(),
    })
    .optional(),
  states: z.array(z.enum(["checked", "expanded", "pressed", "selected"])).optional(),
});

const cachedModifierSchema = z.enum(["Alt", "Control", "Meta", "Shift"]);

const cachedRecordedActionSchema = z.discriminatedUnion("name", [
  z.object({
    name: z.enum(["tap", "doubleTap", "secondaryTap"]),
    summary: z.string(),
    target: cachedTargetDescriptorSchema,
    modifiers: z.array(cachedModifierSchema).optional(),
  }),
  z.object({
    name: z.literal("longPress"),
    summary: z.string(),
    target: cachedTargetDescriptorSchema,
  }),
  z.object({
    name: z.literal("hover"),
    summary: z.string(),
    target: cachedTargetDescriptorSchema,
  }),
  z.object({
    name: z.literal("type"),
    summary: z.string(),
    target: cachedTargetDescriptorSchema,
    value: z.string(),
  }),
  z.object({
    name: z.literal("typeSecret"),
    summary: z.string(),
    target: cachedTargetDescriptorSchema,
    secret: z.string(),
  }),
  z.object({
    name: z.literal("select"),
    summary: z.string(),
    target: cachedTargetDescriptorSchema,
    value: z.string(),
  }),
  z.object({
    name: z.literal("check"),
    summary: z.string(),
    target: cachedTargetDescriptorSchema,
    checked: z.boolean(),
  }),
  z.object({
    name: z.literal("press"),
    summary: z.string(),
    target: cachedTargetDescriptorSchema,
    key: z.string(),
  }),
  z.object({
    name: z.literal("pressKey"),
    summary: z.string(),
    key: z.string(),
  }),
  z.object({
    name: z.literal("upload"),
    summary: z.string(),
    target: cachedTargetDescriptorSchema,
    paths: z.array(z.string()),
  }),
  z.object({
    name: z.literal("drag"),
    summary: z.string(),
    target: cachedTargetDescriptorSchema,
    destination: cachedTargetDescriptorSchema,
  }),
  z.object({
    name: z.literal("scroll"),
    summary: z.string(),
    direction: z.enum(["up", "down", "left", "right"]),
    target: cachedTargetDescriptorSchema.optional(),
    times: z.number().int().min(2).optional(),
    spans: z.number().min(0).max(1).optional(),
  }),
  z.object({
    name: z.literal("navigate"),
    summary: z.string(),
    url: z.string(),
  }),
  z.object({
    name: z.literal("back"),
    summary: z.string(),
  }),
  z.object({
    name: z.literal("dismissKeyboard"),
    summary: z.string(),
  }),
  z.object({
    name: z.literal("resize"),
    summary: z.string(),
    size: z.object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    }),
  }),
  z.object({
    name: z.enum(["tapAt", "hoverAt"]),
    summary: z.string(),
    point: z.object({
      x: z.number(),
      y: z.number(),
    }),
    viewport: z.object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    }),
  }),
]);

const cachedTraceEntryFileSchema = z.object({
  schemaVersion: z.literal(E2E_TRACE_SCHEMA_VERSION),
  payload: z.object({
    actions: z.array(cachedRecordedActionSchema).min(1),
    recordedFor: z
      .object({
        testId: z.string(),
        targetId: z.string(),
        instructionDigest: z.string(),
        paramsDigest: z.string().optional(),
        callIndex: z.number().int().nonnegative().optional(),
        agent: z.string().optional(),
      })
      .optional(),
    summary: z.string(),
    startPath: z.string().optional(),
    endPath: z.string().optional(),
    endAnchors: z.array(cachedTargetDescriptorSchema).optional(),
    goneAnchors: z.array(cachedTargetDescriptorSchema).optional(),
    endWaitMs: z.number().int().nonnegative().optional(),
    truncated: z.boolean().optional(),
  }),
});

type ParsedCachedTraceEntry = z.infer<typeof cachedTraceEntryFileSchema>;
type StepExecutorRunContext = Parameters<
  NonNullable<Extract<AgentConfig, { readonly executor: unknown }>["executor"]>["runStep"]
>[0];
type ObservedTreeNode = NonNullable<
  Awaited<ReturnType<StepExecutorRunContext["observe"]>>["tree"]
>;

interface ProjectedObservedCandidate {
  readonly id: string;
  readonly role?: string;
  readonly name?: string;
  readonly text?: string;
  readonly testId?: string;
  readonly placeholder?: string;
  readonly inputPurpose?: string;
  readonly within?: string;
  readonly value?: string;
  readonly states?: readonly string[];
}

const EXECUTOR_CONTAINER_ROLES = new Set([
  "row",
  "listitem",
  "article",
  "group",
  "region",
  "dialog",
  "tabpanel",
]);

function parseTestIdsFromObservationText(text: string): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  const lineRe = /^\s*#(\S+)\b[^\n]*?\btestid=("(?:[^"\\]|\\.)*")/gm;
  let match: RegExpExecArray | null;
  while ((match = lineRe.exec(text)) !== null) {
    try {
      const parsed: unknown = JSON.parse(match[2]!);
      if (typeof parsed === "string" && parsed.trim() !== "") {
        out.set(match[1]!, parsed.trim());
      }
    } catch {}
  }
  return out;
}

function firstObservedLeafText(node: ObservedTreeNode): string | undefined {
  for (const child of node.children ?? []) {
    if (child.states?.hidden === true) continue;
    const isLeaf = !child.children || child.children.length === 0;
    const own = isLeaf ? (child.text ?? child.name ?? "").trim() : "";
    if (own !== "") return own;
    const deeper = firstObservedLeafText(child);
    if (deeper !== undefined) return deeper;
  }
  return undefined;
}

function isObservedContainerNamedAfterTwin(
  container: ObservedTreeNode,
  cameFrom: ObservedTreeNode | undefined,
): boolean {
  if (!cameFrom || !EXECUTOR_CONTAINER_ROLES.has(cameFrom.role ?? "")) return false;
  for (const child of container.children ?? []) {
    if (child.states?.hidden === true) continue;
    const isLeaf = !child.children || child.children.length === 0;
    const own = isLeaf ? (child.text ?? child.name ?? "").trim() : "";
    if (own === "" && firstObservedLeafText(child) === undefined) continue;
    return child.id !== cameFrom.id && child.role === cameFrom.role;
  }
  return false;
}

function computeObservedWithinKey(
  id: string,
  nodeById: ReadonlyMap<string, ObservedTreeNode>,
  parentById: ReadonlyMap<string, string>,
): string | undefined {
  const node = nodeById.get(id);
  const ownSquashed = (node?.name ?? node?.text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  let came = id;
  let cursor = parentById.get(id);
  while (cursor !== undefined) {
    const container = nodeById.get(cursor);
    if (container && EXECUTOR_CONTAINER_ROLES.has(container.role ?? "")) {
      const leafText = isObservedContainerNamedAfterTwin(container, nodeById.get(came))
        ? undefined
        : firstObservedLeafText(container);
      const ownLabel = (container.name ?? container.text ?? "").trim() || undefined;
      const chosen = boundStr(leafText ?? ownLabel, 80);
      if (!chosen || chosen.toLowerCase() === ownSquashed) return undefined;
      return chosen;
    }
    came = cursor;
    cursor = parentById.get(cursor);
  }
  return undefined;
}

function projectObservedCandidates(
  root: ObservedTreeNode | undefined,
  observationText: string,
): ProjectedObservedCandidate[] {
  if (!root) return [];
  const testIdByNodeId = parseTestIdsFromObservationText(observationText);
  const nodeById = new Map<string, ObservedTreeNode>();
  const parentById = new Map<string, string>();
  const ordered: ObservedTreeNode[] = [];

  const visit = (node: ObservedTreeNode) => {
    if (node.states?.hidden === true) return;
    nodeById.set(node.id, node);
    ordered.push(node);
    for (const child of node.children ?? []) {
      if (child.states?.hidden === true) continue;
      parentById.set(child.id, node.id);
      visit(child);
    }
  };
  visit(root);

  return ordered.map((node) => {
    const role = boundStr(node.role, 300);
    const name = boundStr(node.name, 300);
    const rawText = boundStr(node.text, 300);
    const text =
      rawText !== undefined &&
      rawText !== name &&
      !(role !== undefined && CONTENT_NAMED_ANCHOR_ROLES.has(role) && name !== undefined)
        ? rawText
        : undefined;
    const rawNodeTestId =
      "testId" in node && typeof node.testId === "string" ? node.testId : undefined;
    const testId = boundStr(rawNodeTestId ?? testIdByNodeId.get(node.id), 300);
    const placeholder = boundStr(node.attributes?.["placeholder"], 300);
    const inputPurpose =
      node.inputPurpose && VALID_E2E_INPUT_PURPOSES.has(node.inputPurpose)
        ? node.inputPurpose
        : undefined;
    const within = computeObservedWithinKey(node.id, nodeById, parentById);
    const value =
      node.states?.secure === true ? undefined : boundStr(node.value, 300);
    const activeStates = (["checked", "expanded", "pressed", "selected"] as const).filter(
      (st) => node.states?.[st] === true,
    );
    return {
      id: node.id,
      ...(role !== undefined ? { role } : {}),
      ...(name !== undefined ? { name } : {}),
      ...(text !== undefined ? { text } : {}),
      ...(testId !== undefined ? { testId } : {}),
      ...(placeholder !== undefined ? { placeholder } : {}),
      ...(inputPurpose !== undefined ? { inputPurpose } : {}),
      ...(within !== undefined ? { within } : {}),
      ...(value !== undefined ? { value } : {}),
      ...(activeStates.length > 0 ? { states: activeStates } : {}),
    };
  });
}

function testIdsMatchAcrossMobileAndWeb(
  candidateTestId: string | undefined,
  expectedTestId: string,
): boolean {
  if (candidateTestId === undefined) return false;
  if (candidateTestId === expectedTestId) return true;
  if (candidateTestId.endsWith(`:id/${expectedTestId}`)) return true;
  if (expectedTestId.endsWith(`:id/${candidateTestId}`)) return true;
  return false;
}

function matchTargetInObservedCandidates(
  target: CachedTargetDescriptor,
  candidates: readonly ProjectedObservedCandidate[],
): string | undefined {
  const scoped =
    target.within === undefined
      ? candidates
      : candidates.filter((cand) => cand.within === target.within);

  if (isTargetAnonymous(target)) {
    const matches = scoped.filter(
      (cand) =>
        cand.testId === undefined &&
        cand.name === undefined &&
        cand.text === undefined &&
        cand.placeholder === undefined &&
        cand.role === target.role &&
        cand.inputPurpose === target.inputPurpose,
    );
    if (matches.length === 1 && (target.position === undefined || target.position.of === 1)) {
      return matches[0]!.id;
    }
    if (
      target.position !== undefined &&
      target.position.of === matches.length &&
      target.position.index >= 0 &&
      target.position.index < matches.length
    ) {
      return matches[target.position.index]!.id;
    }
    return undefined;
  }

  const tiers: CachedTargetDescriptor[] = [target];
  if (target.testId !== undefined) {
    const { testId: _omit, ...withoutTestId } = target;
    if (!isTargetAnonymous(withoutTestId)) {
      tiers.push(withoutTestId);
    }
  }

  for (const tier of tiers) {
    const includeText = tier.testId === undefined && tier.name === undefined;
    const matches = scoped.filter((cand) => {
      if (tier.role !== undefined && cand.role !== tier.role) return false;
      if (tier.name !== undefined && cand.name !== tier.name) return false;
      if (
        tier.testId !== undefined &&
        !testIdsMatchAcrossMobileAndWeb(cand.testId, tier.testId)
      ) {
        return false;
      }
      if (tier.placeholder !== undefined && cand.placeholder !== tier.placeholder) return false;
      if (tier.inputPurpose !== undefined && cand.inputPurpose !== tier.inputPurpose) return false;
      if (includeText && tier.text !== undefined && cand.text !== tier.text) return false;
      return true;
    });
    if (matches.length === 0) continue;
    if (matches.length === 1) return matches[0]!.id;
    if (
      target.position !== undefined &&
      target.position.of === matches.length &&
      target.position.index >= 0 &&
      target.position.index < matches.length
    ) {
      return matches[target.position.index]!.id;
    }
    return undefined;
  }
  return undefined;
}

function anchorHoldsOnCandidates(
  anchor: CachedTargetDescriptor,
  candidates: readonly ProjectedObservedCandidate[],
): boolean {
  const expectedStates = anchor.states ? anchor.states.join(",") : "";
  return candidates.some((cand) => {
    const roleMatches =
      anchor.role === undefined ||
      cand.role === anchor.role ||
      (anchor.role === "status" && cand.role === "text");
    if (!roleMatches) return false;
    if (anchor.name !== undefined && cand.name !== anchor.name) return false;
    if (
      anchor.text !== undefined &&
      cand.text !== anchor.text &&
      cand.name !== anchor.text
    ) {
      return false;
    }
    if (
      anchor.testId !== undefined &&
      !testIdsMatchAcrossMobileAndWeb(cand.testId, anchor.testId)
    ) {
      return false;
    }
    if (anchor.placeholder !== undefined && cand.placeholder !== anchor.placeholder) return false;
    if (anchor.inputPurpose !== undefined && cand.inputPurpose !== anchor.inputPurpose) return false;
    if (anchor.value !== undefined && cand.value !== anchor.value) return false;
    const candStates = cand.states ? cand.states.join(",") : "";
    return candStates === expectedStates;
  });
}

const MINTED_ROUTE_SEGMENT_PATTERNS = [
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^[0-9a-f]{8,}$/i,
  /^\d+$/,
  /^(?=(?:[^\d]*\d){2})(?=.*[A-Za-z])[A-Za-z0-9_-]{12,}$/,
  /^[A-Za-z]+-\d{2,}$/,
  /\s/,
];

function normalizeRoutePathnameForReplay(rawPath: string): string {
  const withoutQuery = (rawPath.split(/[?#]/)[0] ?? "/").trim() || "/";
  const trimmed = withoutQuery === "/" ? "/" : `/${withoutQuery.replace(/^\/+|\/+$/g, "")}`;
  if (trimmed === "/") return "/";
  const normalizedSegments = trimmed
    .slice(1)
    .split("/")
    .map((seg) => {
      let decoded = seg;
      try {
        decoded = decodeURIComponent(seg);
      } catch {}
      return MINTED_ROUTE_SEGMENT_PATTERNS.some((re) => re.test(decoded)) ? ":id" : decoded;
    });
  return `/${normalizedSegments.join("/")}`;
}

function isOpaqueDeviceLocation(raw: string): boolean {
  return !raw.startsWith("/") && !/^https?:\/\//i.test(raw);
}

function sameRoutePathname(actualPath: string | undefined, expectedPath: string): boolean {
  if (!actualPath) return false;
  if (isOpaqueDeviceLocation(actualPath) && isOpaqueDeviceLocation(expectedPath)) {
    return actualPath.trim() === expectedPath.trim();
  }
  if (isOpaqueDeviceLocation(actualPath) && expectedPath.startsWith("/")) {
    return true;
  }
  return (
    normalizeRoutePathnameForReplay(actualPath) ===
    normalizeRoutePathnameForReplay(expectedPath)
  );
}

function waitAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function findMatchingCachedTraceEntry(
  cacheDir: string,
  testId: string,
  targetName: string,
  instructionDigest: string,
  paramsDigest: string,
  handoffOrdinal: number,
  hasReplayedPrefix: boolean,
): ParsedCachedTraceEntry | undefined {
  if (!existsSync(cacheDir)) return undefined;
  let fileNames: string[];
  try {
    fileNames = readdirSync(cacheDir).filter((f) => f.endsWith(".json"));
  } catch {
    return undefined;
  }

  const signatureMatches: ParsedCachedTraceEntry[] = [];
  for (const fileName of fileNames) {
    try {
      const raw: unknown = JSON.parse(readFileSync(path.join(cacheDir, fileName), "utf8"));
      const parsed = cachedTraceEntryFileSchema.safeParse(raw);
      if (!parsed.success) continue;
      const rf = parsed.data.payload.recordedFor;
      if (!rf) continue;
      if (rf.testId !== testId || rf.targetId !== targetName) continue;
      if (rf.instructionDigest !== instructionDigest) continue;
      if ((rf.paramsDigest ?? canonicalDigest({})) !== paramsDigest) continue;
      signatureMatches.push(parsed.data);
    } catch {}
  }

  if (signatureMatches.length === 0) return undefined;
  signatureMatches.sort(
    (a, b) => (a.payload.recordedFor?.callIndex ?? 0) - (b.payload.recordedFor?.callIndex ?? 0),
  );
  if (signatureMatches.length === 1) return signatureMatches[0];

  if (!hasReplayedPrefix) {
    const truncatedMatches = signatureMatches.filter((m) => m.payload.truncated === true);
    if (handoffOrdinal < truncatedMatches.length) {
      return truncatedMatches[handoffOrdinal];
    }
  }
  const exactCallMatch = signatureMatches.find(
    (m) => (m.payload.recordedFor?.callIndex ?? 0) === handoffOrdinal,
  );
  return exactCallMatch ?? signatureMatches[handoffOrdinal];
}

async function relocateInExecutorWithBackoff(
  context: StepExecutorRunContext,
  target: CachedTargetDescriptor,
): Promise<string> {
  const delays = [100, 250, 500, 1_000];
  const timeoutMs = Math.min(10_000, Math.max(500, context.budgets.remainingMs() - 1_000));
  const deadline = Date.now() + timeoutMs;

  for (let attempt = 0; ; attempt += 1) {
    const obs = await context.observe({ tree: true });
    const candidates = projectObservedCandidates(obs.tree, obs.text);
    const foundId = matchTargetInObservedCandidates(target, candidates);
    if (foundId !== undefined) return foundId;

    const delay = delays[attempt] ?? delays[delays.length - 1]!;
    if (Date.now() + delay > deadline || context.signal.aborted) {
      throw new AgentError(
        "ACTION_FAILED",
        `Could not relocate recorded target ${JSON.stringify(target)} during zero-LLM cached replay`,
      );
    }
    await waitAbortable(delay, context.signal);
  }
}

// Satisfy e2e WorkerModels.preflight on zero-LLM cached replay and execute unlabeled-twin or hand-off steps deterministically without model calls.
export function softprobeCachedAgent(
  options: SoftprobeCachedAgentOptions = {},
): AgentConfig {
  if (options.model !== undefined) {
    return {
      model: options.model,
      ...(options.judge !== undefined ? { judge: options.judge } : {}),
      ...(options.context !== undefined ? { context: options.context } : {}),
      ...(options.tools !== undefined ? { tools: options.tools } : {}),
    };
  }
  return {
    ...(options.context !== undefined ? { context: options.context } : {}),
    executor: {
      name: "softprobe-cached-replay",
      version: "0.1.0",
      async runStep(context) {
        const activeMeta = resolveCurrentAttemptMetadata();
        const baseRoot = activeMeta.projectRoot ?? process.cwd();
        const rawCacheDir =
          options.cacheDir?.trim() ||
          activeMeta.env.E2E_CACHE_DIR?.trim() ||
          process.env.E2E_CACHE_DIR?.trim() ||
          ".e2e/cache";
        const resolvedCacheDir = path.resolve(baseRoot, rawCacheDir);

        const instructionDigest = sha256Hex(normalizeE2EInstruction(context.step.instruction));
        const paramsDigest = canonicalDigest(context.step.params ?? {});
        const memoryKey = `softprobe:callCounts:${instructionDigest}:${paramsDigest}`;
        const prevCountRaw = context.attempt.memory.get(memoryKey);
        const callIndex = typeof prevCountRaw === "number" ? prevCountRaw : 0;
        context.attempt.memory.set(memoryKey, callIndex + 1);

        const cachedEntry = findMatchingCachedTraceEntry(
          resolvedCacheDir,
          context.attempt.testId,
          context.target.name,
          instructionDigest,
          paramsDigest,
          callIndex,
          context.replayedPrefix !== undefined,
        );
        if (!cachedEntry) {
          throw new AgentError(
            "MODEL_UNAVAILABLE",
            `No cached ActionTrace completed step ${JSON.stringify(context.step.instruction)} and no LLM model was passed to softprobeCachedAgent({ model }). Configure a model in e2e.config.ts to record new agent.act() steps.`,
          );
        }

        const actions = cachedEntry.payload.actions;
        const startIndex = context.replayedPrefix?.replayedActions.length ?? 0;

        for (let idx = startIndex; idx < actions.length; idx += 1) {
          const action = actions[idx]!;
          switch (action.name) {
            case "navigate":
              await context.actions.navigate(action.url);
              break;
            case "back":
              await context.actions.back();
              break;
            case "dismissKeyboard":
              await context.actions.dismissKeyboard();
              break;
            case "pressKey":
              await context.actions.pressKey(action.key);
              break;
            case "resize":
              await context.actions.resize(action.size);
              break;
            case "tapAt":
              await context.actions.tapAt(action.point);
              break;
            case "hoverAt":
              await context.actions.hoverAt(action.point);
              break;
            case "scroll": {
              const repeats = action.times ?? 1;
              if (action.target) {
                const id = await relocateInExecutorWithBackoff(context, action.target);
                for (let r = 0; r < repeats; r += 1) {
                  await context.actions.scroll(action.direction, { id });
                }
              } else {
                for (let r = 0; r < repeats; r += 1) {
                  await context.actions.scroll(action.direction);
                }
              }
              break;
            }
            case "tap": {
              const id = await relocateInExecutorWithBackoff(context, action.target);
              await context.actions.tap(
                { id },
                action.modifiers && action.modifiers.length > 0
                  ? { modifiers: action.modifiers }
                  : undefined,
              );
              break;
            }
            case "doubleTap": {
              const id = await relocateInExecutorWithBackoff(context, action.target);
              await context.actions.doubleTap(
                { id },
                action.modifiers && action.modifiers.length > 0
                  ? { modifiers: action.modifiers }
                  : undefined,
              );
              break;
            }
            case "longPress": {
              const id = await relocateInExecutorWithBackoff(context, action.target);
              await context.actions.longPress({ id });
              break;
            }
            case "secondaryTap": {
              const id = await relocateInExecutorWithBackoff(context, action.target);
              await context.actions.secondaryTap(
                { id },
                action.modifiers && action.modifiers.length > 0
                  ? { modifiers: action.modifiers }
                  : undefined,
              );
              break;
            }
            case "hover": {
              const id = await relocateInExecutorWithBackoff(context, action.target);
              await context.actions.hover({ id });
              break;
            }
            case "type": {
              const id = await relocateInExecutorWithBackoff(context, action.target);
              await context.actions.type({ id }, action.value);
              break;
            }
            case "typeSecret": {
              const id = await relocateInExecutorWithBackoff(context, action.target);
              await context.actions.typeSecret({ id }, action.secret);
              break;
            }
            case "select": {
              const id = await relocateInExecutorWithBackoff(context, action.target);
              await context.actions.select({ id }, action.value);
              break;
            }
            case "check": {
              const id = await relocateInExecutorWithBackoff(context, action.target);
              await context.actions.check({ id }, action.checked);
              break;
            }
            case "press": {
              const id = await relocateInExecutorWithBackoff(context, action.target);
              await context.actions.press({ id }, action.key);
              break;
            }
            case "upload": {
              const id = await relocateInExecutorWithBackoff(context, action.target);
              await context.actions.upload({ id }, action.paths);
              break;
            }
            case "drag": {
              const srcId = await relocateInExecutorWithBackoff(context, action.target);
              const dstId = await relocateInExecutorWithBackoff(context, action.destination);
              await context.actions.drag({ id: srcId }, { id: dstId });
              break;
            }
            default: {
              const _exhaustive: never = action;
              return _exhaustive;
            }
          }
        }

        const expectedEndPath = cachedEntry.payload.endPath;
        const requiredAnchors = cachedEntry.payload.endAnchors ?? [];
        const forbiddenAnchors = cachedEntry.payload.goneAnchors ?? [];
        const hasAnchorChecks = requiredAnchors.length > 0 || forbiddenAnchors.length > 0;
        if (expectedEndPath !== undefined || hasAnchorChecks) {
          const delays = [100, 250, 500, 1_000];
          const waitBudget = Math.min(
            cachedEntry.payload.endWaitMs ?? 15_000,
            Math.max(500, context.budgets.remainingMs() - 500),
          );
          const deadline = Date.now() + waitBudget;
          for (let attempt = 0; ; attempt += 1) {
            const obs = await context.observe({
              tree: hasAnchorChecks,
            });
            const pathOk =
              expectedEndPath === undefined ||
              obs.path === undefined ||
              sameRoutePathname(obs.path, expectedEndPath);
            const anchorsOk =
              !hasAnchorChecks ||
              (() => {
                const candidates = projectObservedCandidates(obs.tree, obs.text);
                return (
                  requiredAnchors.every((anc) => anchorHoldsOnCandidates(anc, candidates)) &&
                  forbiddenAnchors.every((anc) => !anchorHoldsOnCandidates(anc, candidates))
                );
              })();
            if (pathOk && anchorsOk) break;

            const delay = delays[attempt] ?? delays[delays.length - 1]!;
            if (Date.now() + delay > deadline || context.signal.aborted) {
              return {
                status: "failed",
                summary: `Recorded end state did not hold on ${obs.path ?? "screen"} (expected path ${expectedEndPath ?? "any"})`,
              };
            }
            await waitAbortable(delay, context.signal);
          }
        }

        return {
          status: "passed",
          summary: cachedEntry.payload.summary || "replayed cached agent step",
        };
      },
    },
  };
}
