import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  DEFAULT_EXPLORER_URL,
  INGESTION_KEY_ENV_VAR,
  type FetchLike,
  type HookAgent,
  type HookOptions,
} from "./types.js";

export type HookTelemetryConfig = {
  readonly ingestionKey: string;
  readonly otlpEndpoint: string;
  readonly serviceName?: string;
  readonly environment?: string;
};

type PendingTool = {
  spanId: string;
  startNs: string;
  toolName: string;
  input?: unknown;
};

type HookSessionState = {
  traceId: string;
  turnSpanId?: string;
  turnStartNs?: string;
  pendingTools: Record<string, PendingTool>;
};

export type HookDeps = {
  readonly fetch?: FetchLike;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly nowNs?: () => string;
};

export type HookRunResult = {
  readonly ok: boolean;
  readonly skipped?: boolean;
  readonly exportedSpans: number;
  readonly stdout?: string;
};

type OtlpKeyValue = {
  key: string;
  value: { stringValue: string } | { intValue: string };
};

type OtlpSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpKeyValue[];
  status: { code: number; message?: string };
};

export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function defaultNowNs(): string {
  return (BigInt(Date.now()) * 1_000_000n).toString();
}

function deterministicTraceId(sessionId: string): string {
  return createHash("sha256").update(`softprobe:hook:${sessionId}`).digest("hex").slice(0, 32);
}

function randomSpanId(): string {
  return randomBytes(8).toString("hex");
}

function defaultTelemetryConfigPath(env: NodeJS.ProcessEnv, homeDir: string): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const base = xdg || path.join(homeDir, ".config");
  return path.join(base, "softprobe", "agent-telemetry.json");
}

function sessionStatePath(sessionId: string, env: NodeJS.ProcessEnv, homeDir: string): string {
  const xdgCache = env.XDG_CACHE_HOME?.trim();
  const base = xdgCache || path.join(homeDir, ".cache");
  const digest = createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
  return path.join(base, "softprobe", "hooks", `${digest}.json`);
}

function normalizeOtlpEndpoint(raw?: string): string {
  const trimmed = (raw ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) return `${DEFAULT_EXPLORER_URL}/api/thelake/v1/traces`;
  if (trimmed.endsWith("/v1/traces")) return trimmed;
  if (trimmed.endsWith("/api/thelake")) return `${trimmed}/v1/traces`;
  return `${trimmed}/api/thelake/v1/traces`;
}

export async function resolveHookTelemetryConfig(
  options: HookOptions,
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = homedir(),
): Promise<HookTelemetryConfig | null> {
  const cfgPath = options.configPath || defaultTelemetryConfigPath(env, homeDir);
  try {
    const raw = JSON.parse(await readFile(cfgPath, "utf8")) as Record<string, unknown>;
    const key = typeof raw.ingestionKey === "string" ? raw.ingestionKey.trim() : "";
    if (key) {
      const endpoint =
        typeof raw.otlpEndpoint === "string"
          ? normalizeOtlpEndpoint(raw.otlpEndpoint)
          : typeof raw.explorerUrl === "string"
            ? normalizeOtlpEndpoint(raw.explorerUrl)
            : normalizeOtlpEndpoint(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT);
      return {
        ingestionKey: key,
        otlpEndpoint: endpoint,
        ...(typeof raw.serviceName === "string" && raw.serviceName.trim()
          ? { serviceName: raw.serviceName.trim() }
          : {}),
        ...(typeof raw.environment === "string" && raw.environment.trim()
          ? { environment: raw.environment.trim() }
          : {}),
      };
    }
  } catch {
    // Fall back to environment variables
  }

  const envKey = (
    env[INGESTION_KEY_ENV_VAR] ??
    env.SOFTPROBE_INGESTION_KEY ??
    env.INGESTION_KEY ??
    ""
  ).trim();
  if (!envKey) return null;

  return {
    ingestionKey: envKey,
    otlpEndpoint: normalizeOtlpEndpoint(
      env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? env.OTEL_EXPORTER_OTLP_ENDPOINT,
    ),
  };
}

function detectAgent(requested: HookAgent, payload: Record<string, unknown>): "cursor" | "claude-code" {
  if (requested === "cursor" || requested === "claude-code") return requested;
  const ev = typeof payload.hook_event_name === "string" ? payload.hook_event_name : "";
  if (ev && /^[A-Z]/.test(ev)) return "claude-code";
  if (typeof payload.conversation_id === "string") return "cursor";
  return "claude-code";
}

function cursorAllowStdout(eventName: string, agent: "cursor" | "claude-code"): string | undefined {
  if (agent !== "cursor") return undefined;
  if (eventName === "beforeSubmitPrompt" || eventName === "preToolUse") {
    return JSON.stringify({ continue: true, permission: "allow" });
  }
  return undefined;
}

function strAttr(key: string, value: string): OtlpKeyValue {
  return { key, value: { stringValue: value } };
}

function stringifyVal(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function loadState(
  filePath: string,
  sessionId: string,
): Promise<HookSessionState> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as HookSessionState;
    if (parsed && typeof parsed.traceId === "string" && parsed.pendingTools) {
      return parsed;
    }
  } catch {
    // New session state
  }
  return {
    traceId: deterministicTraceId(sessionId),
    pendingTools: {},
  };
}

async function saveState(filePath: string, state: HookSessionState): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(state), "utf8");
}

export async function runHook(
  options: HookOptions,
  stdinText: string,
  deps: HookDeps = {},
): Promise<HookRunResult> {
  const env = deps.env ?? process.env;
  const homeDir = deps.homeDir ?? homedir();
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const nowNs = deps.nowNs ?? defaultNowNs;

  let payload: Record<string, unknown> = {};
  if (stdinText.trim()) {
    try {
      const parsed = JSON.parse(stdinText);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      }
    } catch {
      return { ok: true, skipped: true, exportedSpans: 0 };
    }
  }

  const agent = detectAgent(options.agent, payload);
  const eventName =
    typeof payload.hook_event_name === "string" ? payload.hook_event_name : "";
  const stdout = cursorAllowStdout(eventName, agent);

  const config = await resolveHookTelemetryConfig(options, env, homeDir);
  if (!config) {
    return { ok: true, skipped: true, exportedSpans: 0, ...(stdout ? { stdout } : {}) };
  }

  const sessionId = String(
    payload.conversation_id ?? payload.session_id ?? "unknown-session",
  ).trim() || "unknown-session";

  const stateFile = sessionStatePath(sessionId, env, homeDir);
  const state = await loadState(stateFile, sessionId);
  const ts = nowNs();
  const spans: OtlpSpan[] = [];

  const baseAttrs = (obsType: string): OtlpKeyValue[] => [
    strAttr("sp.session.id", sessionId),
    strAttr("gen_ai.conversation.id", sessionId),
    strAttr("sp.observation.type", obsType),
    strAttr("gen_ai.agent.name", config.serviceName ?? agent),
  ];

  const evLower = eventName.toLowerCase();

  if (evLower === "beforesubmitprompt" || evLower === "userpromptsubmit") {
    const turnSpanId = randomSpanId();
    state.turnSpanId = turnSpanId;
    state.turnStartNs = ts;
    const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
    const attrs = baseAttrs("user");
    if (prompt) attrs.push(strAttr("sp.input", prompt));
    spans.push({
      traceId: state.traceId,
      spanId: randomSpanId(),
      parentSpanId: turnSpanId,
      name: `${agent}.user`,
      kind: 1,
      startTimeUnixNano: ts,
      endTimeUnixNano: ts,
      attributes: attrs,
      status: { code: 1 },
    });
  } else if (evLower === "pretooluse") {
    const toolName = String(payload.tool_name ?? "tool");
    const key =
      typeof payload.tool_use_id === "string" && payload.tool_use_id
        ? payload.tool_use_id
        : toolName;
    state.pendingTools[key] = {
      spanId: randomSpanId(),
      startNs: ts,
      toolName,
      input: payload.tool_input,
    };
  } else if (evLower === "posttooluse" || evLower === "posttoolusefailure") {
    const toolName = String(payload.tool_name ?? "tool");
    const key =
      typeof payload.tool_use_id === "string" && payload.tool_use_id
        ? payload.tool_use_id
        : toolName;
    const pending = state.pendingTools[key];
    if (pending) delete state.pendingTools[key];

    const isFailure = evLower === "posttoolusefailure" || Boolean(payload.error);
    const attrs = [
      ...baseAttrs("tool"),
      strAttr("gen_ai.operation.name", "execute_tool"),
      strAttr("gen_ai.tool.name", toolName),
    ];
    if (typeof payload.tool_use_id === "string" && payload.tool_use_id) {
      attrs.push(strAttr("gen_ai.tool.call.id", payload.tool_use_id));
    }
    const toolInput = payload.tool_input ?? pending?.input;
    if (toolInput !== undefined) {
      attrs.push(strAttr("sp.input", stringifyVal(toolInput)));
    }
    const toolOutput = payload.tool_output ?? payload.tool_response ?? payload.error;
    if (toolOutput !== undefined) {
      attrs.push(strAttr("sp.output", stringifyVal(toolOutput)));
    }
    spans.push({
      traceId: state.traceId,
      spanId: pending?.spanId ?? randomSpanId(),
      ...(state.turnSpanId ? { parentSpanId: state.turnSpanId } : {}),
      name: `${agent}.tool.${toolName}`,
      kind: 1,
      startTimeUnixNano: pending?.startNs ?? ts,
      endTimeUnixNano: ts,
      attributes: attrs,
      status: isFailure
        ? { code: 2, message: stringifyVal(payload.error ?? toolOutput ?? "Tool failed") }
        : { code: 1 },
    });
  } else if (evLower === "afteragentthought") {
    const thought = typeof payload.text === "string" ? payload.text : stringifyVal(payload.thought ?? "");
    if (thought) {
      const attrs = [...baseAttrs("thought"), strAttr("sp.output", thought)];
      spans.push({
        traceId: state.traceId,
        spanId: randomSpanId(),
        ...(state.turnSpanId ? { parentSpanId: state.turnSpanId } : {}),
        name: `${agent}.thought`,
        kind: 1,
        startTimeUnixNano: ts,
        endTimeUnixNano: ts,
        attributes: attrs,
        status: { code: 1 },
      });
    }
  } else if (evLower === "afteragentresponse") {
    const text = typeof payload.text === "string" ? payload.text : "";
    const attrs = [
      ...baseAttrs("generation"),
      strAttr("gen_ai.operation.name", "chat"),
      ...(text ? [strAttr("sp.output", text)] : []),
    ];
    spans.push({
      traceId: state.traceId,
      spanId: randomSpanId(),
      ...(state.turnSpanId ? { parentSpanId: state.turnSpanId } : {}),
      name: `${agent}.generation`,
      kind: 1,
      startTimeUnixNano: ts,
      endTimeUnixNano: ts,
      attributes: attrs,
      status: { code: 1 },
    });
  } else if (evLower === "stop" || evLower === "subagentstop") {
    const lastMessage =
      typeof payload.last_assistant_message === "string"
        ? payload.last_assistant_message
        : "";
    if (lastMessage) {
      spans.push({
        traceId: state.traceId,
        spanId: randomSpanId(),
        ...(state.turnSpanId ? { parentSpanId: state.turnSpanId } : {}),
        name: `${agent}.generation`,
        kind: 1,
        startTimeUnixNano: ts,
        endTimeUnixNano: ts,
        attributes: [
          ...baseAttrs("generation"),
          strAttr("gen_ai.operation.name", "chat"),
          strAttr("sp.output", lastMessage),
        ],
        status: { code: 1 },
      });
    }
    if (state.turnSpanId) {
      spans.push({
        traceId: state.traceId,
        spanId: state.turnSpanId,
        name: `${agent}.turn`,
        kind: 1,
        startTimeUnixNano: state.turnStartNs ?? ts,
        endTimeUnixNano: ts,
        attributes: [...baseAttrs("agent"), strAttr("gen_ai.operation.name", "invoke_agent")],
        status: { code: 1 },
      });
      state.turnSpanId = undefined;
      state.turnStartNs = undefined;
    }
  }

  await saveState(stateFile, state).catch(() => undefined);

  if (spans.length === 0) {
    return { ok: true, exportedSpans: 0, ...(stdout ? { stdout } : {}) };
  }

  const resourceAttrs: OtlpKeyValue[] = [
    strAttr("service.name", config.serviceName ?? agent),
    ...(config.environment ? [strAttr("deployment.environment.name", config.environment)] : []),
  ];

  const otlpPayload = {
    resourceSpans: [
      {
        resource: { attributes: resourceAttrs },
        scopeSpans: [
          {
            scope: { name: "@softprobe/blackbox-hooks", version: "0.2.7" },
            spans,
          },
        ],
      },
    ],
  };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      await fetchImpl(config.otlpEndpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.ingestionKey}`,
        },
        body: JSON.stringify(otlpPayload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    if (env.SOFTPROBE_DEBUG === "1") {
      console.error("[softprobe-blackbox hook] export failed:", err);
    }
  }

  return { ok: true, exportedSpans: spans.length, ...(stdout ? { stdout } : {}) };
}
