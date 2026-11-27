import { Plugin } from "@opencode/plugin";
import type { PluginOptions } from "@opencode/plugin";

export const BLACKBOX_MCP_NAME = "blackbox";
export const DEFAULT_BLACKBOX_MCP_URL = "https://explorer.softprobe.ai/mcp";

export const BLACKBOX_SYSTEM_PROMPT = [
  "You have access to the Softprobe Blackbox MCP server (`blackbox`).",
  "Use `blackbox` tools when investigating recorded application or agent sessions, traces, spans, errors, latency, LLM/tool calls, or E2E flows in Softprobe Explorer.",
  "For UI test generation from a recorded web or mobile session, call `get_session_semantic_actions` to inspect the semantic action timeline and locators, call `get_trace` on selected caused traces for payload details, and write deterministic `@playwright/test` + `@softprobe/e2e/playwright` tests for web or `@softprobe/e2e/mobile` (`{ app, screen, device, trace }`) or Maestro (`.yaml`) tests for iOS and Android.",
  "Use `bootstrap_project` when the user asks to provision telemetry setup for a project or enable OpenCode trajectory capture (configuring `@softprobe/opencode-plugin` and `~/.config/opencode/opencode-softprobe.json`).",
  "If a `blackbox` MCP tool call fails due to missing or expired authentication, instruct the user to run `opencode mcp auth blackbox`.",
].join(" ");

/**
 * Resolve the remote Blackbox MCP endpoint URL from plugin options or `BLACKBOX_MCP_URL`.
 */
export function resolveBlackboxMcpUrl(
  options?: PluginOptions,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (typeof options?.url === "string" && options.url.trim().length > 0) {
    return options.url.trim();
  }
  const envUrl = env.BLACKBOX_MCP_URL?.trim();
  if (envUrl && envUrl.length > 0) {
    return envUrl;
  }
  return DEFAULT_BLACKBOX_MCP_URL;
}

/**
 * OpenCode plugin that registers the `blackbox` remote HTTP MCP server and
 * injects Blackbox usage guidance into the chat system prompt.
 */
export const BlackboxPlugin: Plugin.Plugin = Plugin.define({
  id: "softprobe-blackbox",
  async setup(context) {
    const url = resolveBlackboxMcpUrl(context.options);

    await context.mcp.transform((editor) => {
      if (!editor.get(BLACKBOX_MCP_NAME)) {
        editor.set(BLACKBOX_MCP_NAME, { type: "remote", url });
      }
    });

    await context.session.hook("context", (event) => {
      if (
        !event.system.some(
          (part) => part.type === "text" && part.text === BLACKBOX_SYSTEM_PROMPT,
        )
      ) {
        event.system.push({ type: "text", text: BLACKBOX_SYSTEM_PROMPT });
      }
    });
  },
});

export default BlackboxPlugin;
