import type { ToolKind } from "@softprobe/tracing";

const SHELL_TOOLS = new Set(["bash", "shell", "exec"]);
const FILE_TOOLS = new Set([
  "read",
  "write",
  "edit",
  "apply_patch",
  "multiedit",
  "list",
  "glob",
  "grep",
]);

/** Map OpenCode tool names to Part A `sp.tool.kind` values. */
export function inferToolKind(toolName: string): ToolKind {
  const name = toolName.trim().toLowerCase();
  if (!name) return "other";
  if (SHELL_TOOLS.has(name) || name.includes("shell") || name.includes("bash")) {
    return "shell";
  }
  if (FILE_TOOLS.has(name) || name.startsWith("file.")) {
    return "file";
  }
  if (name.includes("mcp") || name.startsWith("mcp_")) {
    return "mcp";
  }
  return "function";
}
