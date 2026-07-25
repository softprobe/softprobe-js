import type { Attributes, JsonValue } from "./types.js";

export const TOOL_KINDS = [
  "function",
  "mcp",
  "shell",
  "file",
  "hook",
  "other",
] as const;
export type ToolKind = (typeof TOOL_KINDS)[number];

export const TOOL_STATUSES = ["ok", "error", "cancelled"] as const;
export type ToolStatus = (typeof TOOL_STATUSES)[number];

export type NormalizedToolDefinition = {
  name: string;
  description?: JsonValue;
  parameters?: JsonValue;
};

export type NormalizedToolCall = {
  id?: string;
  name: string;
  arguments: JsonValue;
  index?: number;
  type?: string;
};

type ObservationLike = {
  update: (options: { attributes?: Attributes; output?: JsonValue }) => void;
  addContentEvent?: (name: string, content: JsonValue) => void;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function argumentsValue(raw: unknown): JsonValue {
  if (
    raw === null ||
    typeof raw === "string" ||
    typeof raw === "number" ||
    typeof raw === "boolean" ||
    Array.isArray(raw) ||
    (raw && typeof raw === "object")
  ) {
    return raw as JsonValue;
  }
  if (raw === undefined) return {};
  return String(raw);
}

export function normalizeToolDefinitions(
  tools: unknown,
): NormalizedToolDefinition[] {
  if (!Array.isArray(tools)) return [];
  const out: NormalizedToolDefinition[] = [];
  for (const item of tools) {
    const mapping = asRecord(item);
    if (!mapping) continue;
    const fn = asRecord(mapping.function);
    if (fn?.name) {
      out.push({
        name: String(fn.name),
        description: (fn.description as JsonValue) ?? undefined,
        parameters: (fn.parameters as JsonValue) ?? undefined,
      });
      continue;
    }
    const name = mapping.name ?? mapping.toolName;
    if (name) {
      out.push({
        name: String(name),
        description: (mapping.description as JsonValue) ?? undefined,
        parameters:
          ((mapping.parameters ??
            mapping.input_schema ??
            mapping.inputSchema) as JsonValue) ?? undefined,
      });
    }
  }
  return out;
}

export function normalizeToolCalls(toolCalls: unknown): NormalizedToolCall[] {
  if (!Array.isArray(toolCalls)) return [];
  const out: NormalizedToolCall[] = [];
  toolCalls.forEach((item, index) => {
    const mapping = asRecord(item);
    if (!mapping) return;
    const fn = asRecord(mapping.function);
    const callId =
      mapping.id ?? mapping.toolCallId ?? mapping.tool_call_id ?? undefined;
    let name: unknown;
    let args: unknown = {};
    if (fn) {
      name = fn.name;
      args = fn.arguments;
    } else {
      name = mapping.name ?? mapping.toolName;
      args =
        mapping.arguments !== undefined
          ? mapping.arguments
          : mapping.args !== undefined
            ? mapping.args
            : mapping.input;
    }
    if (!name) return;
    const normalized: NormalizedToolCall = {
      name: String(name),
      arguments: argumentsValue(args),
      index:
        typeof mapping.index === "number" ? mapping.index : index,
    };
    if (callId) normalized.id = String(callId);
    if (mapping.type) normalized.type = String(mapping.type);
    out.push(normalized);
  });
  return out;
}

export function toolDefinitionAttributes(
  definitions: NormalizedToolDefinition[],
): Attributes {
  const names = definitions.map((d) => d.name);
  return {
    "sp.tool.available_names": names,
    "sp.tool.available_count": names.length,
  };
}

export function toolCallAttributes(calls: NormalizedToolCall[]): Attributes {
  const names = calls.map((c) => c.name);
  const ids = calls.map((c) => c.id).filter((id): id is string => Boolean(id));
  const attrs: Attributes = {
    "sp.tool.call_names": names,
    "sp.tool.call_count": names.length,
  };
  if (ids.length) attrs["sp.tool.call_ids"] = ids;
  return attrs;
}

export function toolSpanAttributes(options: {
  toolName?: string;
  toolCallId?: string;
  kind?: string;
  status?: string;
  index?: number;
  mcpServer?: string;
  mcpTool?: string;
}): Attributes {
  const attrs: Attributes = {};
  if (options.toolName) attrs["gen_ai.tool.name"] = options.toolName;
  if (options.toolCallId) attrs["gen_ai.tool.call.id"] = options.toolCallId;
  if (options.kind) {
    attrs["sp.tool.kind"] = (TOOL_KINDS as readonly string[]).includes(
      options.kind,
    )
      ? options.kind
      : "other";
  }
  if (options.status) attrs["sp.tool.status"] = options.status;
  if (options.index !== undefined) attrs["sp.tool.index"] = options.index;
  if (options.mcpServer) attrs["sp.mcp.server"] = options.mcpServer;
  if (options.mcpTool) attrs["sp.mcp.tool"] = options.mcpTool;
  return attrs;
}

export function recordToolDefinitions(
  observation: ObservationLike,
  tools: unknown,
): NormalizedToolDefinition[] {
  const definitions = normalizeToolDefinitions(tools);
  const attrs = toolDefinitionAttributes(definitions);
  if (Object.keys(attrs).length) observation.update({ attributes: attrs });
  return definitions;
}

export function recordToolCalls(
  observation: ObservationLike,
  toolCalls: unknown,
): NormalizedToolCall[] {
  const calls = normalizeToolCalls(toolCalls);
  const attrs = toolCallAttributes(calls);
  if (Object.keys(attrs).length) observation.update({ attributes: attrs });
  return calls;
}

export function toolResultEventPayload(options: {
  name: string;
  content: JsonValue;
  toolCallId?: string;
  role?: string;
}): Record<string, JsonValue> {
  const payload: Record<string, JsonValue> = {
    role: options.role ?? "tool",
    name: options.name,
    content: options.content,
  };
  if (options.toolCallId) payload.tool_call_id = options.toolCallId;
  return payload;
}

export type ToolCallDeltaState = Record<
  number,
  { id?: string | null; type?: string | null; name?: string | null; arguments: string }
>;

export function accumulateToolCallDeltas(
  state: ToolCallDeltaState,
  deltas: unknown,
): ToolCallDeltaState {
  if (!Array.isArray(deltas)) return state;
  for (const delta of deltas) {
    const mapping = asRecord(delta);
    if (!mapping) continue;
    const index =
      typeof mapping.index === "number" ? mapping.index : Number(mapping.index ?? 0);
    const entry = state[index] ?? {
      id: null,
      type: null,
      name: null,
      arguments: "",
    };
    if (mapping.id && !entry.id) entry.id = String(mapping.id);
    if (mapping.type && !entry.type) entry.type = String(mapping.type);
    const fn = asRecord(mapping.function) ?? {};
    if (fn.name && !entry.name) entry.name = String(fn.name);
    if (fn.arguments) entry.arguments += String(fn.arguments);
    if (mapping.name && !entry.name) entry.name = String(mapping.name);
    if (mapping.arguments !== undefined && !asRecord(mapping.function)) {
      entry.arguments += String(mapping.arguments);
    }
    state[index] = entry;
  }
  return state;
}

export function finalizeToolCallDeltas(
  state: ToolCallDeltaState,
): NormalizedToolCall[] {
  return Object.keys(state)
    .map((k) => Number(k))
    .sort((a, b) => a - b)
    .map((index) => {
      const entry = state[index];
      if (!entry?.name) return null;
      const call: NormalizedToolCall = {
        name: entry.name,
        arguments: entry.arguments || "",
        index,
      };
      if (entry.id) call.id = entry.id;
      if (entry.type) call.type = entry.type;
      return call;
    })
    .filter((c): c is NormalizedToolCall => c !== null);
}
