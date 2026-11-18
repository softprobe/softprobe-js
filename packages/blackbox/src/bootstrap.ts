import type { ExplorerUrl, FetchLike, IngestionKey, ProjectName } from "./types.js";

type McpToolCallOutput = {
  readonly isError: boolean;
  readonly body: Record<string, unknown>;
};

function parseMcpToolResponse(raw: unknown): McpToolCallOutput {
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid JSON-RPC response from Explorer MCP endpoint");
  }
  const rpc = raw as {
    error?: { message?: unknown };
    result?: {
      isError?: unknown;
      content?: Array<{ type?: unknown; text?: unknown }>;
    };
  };
  if (rpc.error) {
    const msg = typeof rpc.error.message === "string" ? rpc.error.message : "Unknown MCP error";
    throw new Error(msg);
  }
  const text = rpc.result?.content?.find((item) => item.type === "text")?.text;
  let body: Record<string, unknown> = {};
  if (typeof text === "string" && text.trim()) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object") {
        body = parsed as Record<string, unknown>;
      } else {
        body = { message: text };
      }
    } catch {
      body = { message: text };
    }
  }
  return {
    isError: Boolean(rpc.result?.isError),
    body,
  };
}

async function callMcpTool(params: {
  readonly explorerUrl: ExplorerUrl;
  readonly accessToken: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly fetch: FetchLike;
}): Promise<McpToolCallOutput> {
  const res = await params.fetch(`${params.explorerUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${params.accessToken}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `${params.name}-${Date.now()}`,
      method: "tools/call",
      params: {
        name: params.name,
        arguments: params.args,
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`Explorer MCP request failed (${res.status} ${res.statusText})`);
  }
  const json: unknown = await res.json();
  return parseMcpToolResponse(json);
}

function extractApiKey(body: Record<string, unknown>): IngestionKey | null {
  for (const field of ["apiKey", "api_key", "ingestionKey", "ingestion_key", "SOFTPROBE_INGESTION_KEY"]) {
    const value = body[field];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim() as IngestionKey;
    }
  }
  return null;
}

/**
 * Create or reuse an Agent in Explorer via `/mcp` and return its Ingestion Key.
 */
export async function bootstrapIngestionKey(params: {
  readonly explorerUrl: ExplorerUrl;
  readonly accessToken: string;
  readonly projectName: ProjectName;
  readonly fetch: FetchLike;
}): Promise<IngestionKey> {
  const created = await callMcpTool({
    explorerUrl: params.explorerUrl,
    accessToken: params.accessToken,
    name: "create_agent",
    args: { name: params.projectName },
    fetch: params.fetch,
  });

  if (!created.isError) {
    const key = extractApiKey(created.body);
    if (key) return key;
  }

  if (created.body.code === "agent_id_exists" && typeof created.body.agent_id === "string") {
    const existing = await callMcpTool({
      explorerUrl: params.explorerUrl,
      accessToken: params.accessToken,
      name: "get_ingestion_key",
      args: { agent_id: created.body.agent_id },
      fetch: params.fetch,
    });
    if (!existing.isError) {
      const key = extractApiKey(existing.body);
      if (key) return key;
    }
    const msg =
      typeof existing.body.message === "string"
        ? existing.body.message
        : "Failed to retrieve ingestion key for existing agent";
    throw new Error(msg);
  }

  const msg =
    typeof created.body.message === "string"
      ? created.body.message
      : "Failed to provision ingestion key from Explorer";
  throw new Error(msg);
}
