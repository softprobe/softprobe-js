import type {
  BootstrapProjectResult,
  ExplorerUrl,
  FetchLike,
  IngestionKey,
  ProjectName,
} from "./types.js";

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

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Provision or reuse a workspace, Agent, and Ingestion Key via Explorer's `bootstrap_project` MCP tool.
 */
export async function bootstrapProject(params: {
  readonly explorerUrl: ExplorerUrl;
  readonly accessToken: string;
  readonly projectName: ProjectName;
  readonly fetch: FetchLike;
}): Promise<BootstrapProjectResult> {
  const res = await params.fetch(`${params.explorerUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${params.accessToken}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `bootstrap_project-${Date.now()}`,
      method: "tools/call",
      params: {
        name: "bootstrap_project",
        arguments: { project_name: params.projectName },
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`Explorer MCP request failed (${res.status} ${res.statusText})`);
  }

  const json: unknown = await res.json();
  const output = parseMcpToolResponse(json);

  if (output.isError) {
    const msg =
      nonEmptyString(output.body.message) ?? "Failed to bootstrap project from Explorer";
    throw new Error(msg);
  }

  const workspaceId = nonEmptyString(output.body.workspaceId);
  const agentId = nonEmptyString(output.body.agentId);
  const ingestionKey = nonEmptyString(output.body.ingestionKey);
  const otlpEndpoint = nonEmptyString(output.body.otlpEndpoint);

  if (!workspaceId || !agentId || !ingestionKey || !otlpEndpoint) {
    throw new Error("Explorer bootstrap_project response is missing required fields");
  }

  return {
    workspaceId,
    agentId,
    ingestionKey: ingestionKey as IngestionKey,
    otlpEndpoint,
  };
}
