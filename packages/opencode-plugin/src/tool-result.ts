/**
 * Normalize `tool.execute.after` payload into Softprobe's expected
 * `{ title, output }` shape.
 *
 * OpenCode registry tools pass `{ title, output, metadata }` already.
 * MCP tools currently fire the after-hook with the raw CallToolResult
 * (`{ content: [...] }`) before OpenCode normalizes it — so `output`
 * is missing and Softprobe would record `sp.output: "{}"`.
 */
export type ToolExecuteAfterOutput = {
  title?: string;
  output?: string;
  metadata?: unknown;
  content?: Array<{
    type?: string;
    text?: string;
    resource?: { text?: string };
  }>;
  isError?: boolean;
};

export type NormalizedToolResult = {
  title: string;
  output: string;
  status: "ok" | "error";
};

function textFromMcpContent(
  content: ToolExecuteAfterOutput["content"],
): string {
  if (!Array.isArray(content)) return "";
  const textParts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "text" && typeof item.text === "string") {
      textParts.push(item.text);
      continue;
    }
    if (
      item.type === "resource" &&
      typeof item.resource?.text === "string"
    ) {
      textParts.push(item.resource.text);
    }
  }
  return textParts.join("\n\n");
}

export function normalizeToolExecuteAfterOutput(
  output: ToolExecuteAfterOutput | null | undefined,
): NormalizedToolResult {
  const status: "ok" | "error" = output?.isError ? "error" : "ok";
  const title = typeof output?.title === "string" ? output.title : "";

  if (typeof output?.output === "string") {
    return { title, output: output.output, status };
  }

  return {
    title,
    output: textFromMcpContent(output?.content),
    status,
  };
}
