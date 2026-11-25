import type { Config, Hooks, Plugin, PluginOptions } from "@opencode-ai/plugin";

export const BLACKBOX_MCP_NAME = "blackbox";
export const DEFAULT_BLACKBOX_MCP_URL = "https://explorer.softprobe.ai/mcp";

export const BLACKBOX_SYSTEM_PROMPT = [
  "You have access to the Softprobe Blackbox MCP server (`blackbox`).",
  "Use `blackbox` tools when investigating recorded application or agent sessions, traces, spans, errors, latency, LLM/tool calls, or E2E flows in Softprobe Explorer.",
  "For UI test generation from a recorded web or mobile session, call `get_session_semantic_actions` to inspect the semantic action timeline and locators, call `get_trace` on selected caused traces for payload details, and write deterministic `@playwright/test` + `@softprobe/e2e/playwright` tests for web or `@softprobe/e2e/mobile` (`{ app, screen, device, trace }`) or Maestro (`.yaml`) tests for iOS and Android.",
  "Use `bootstrap_project` when the user asks to provision telemetry setup for a project.",
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
export const BlackboxPlugin: Plugin = async (_input, options) => {
  const url = resolveBlackboxMcpUrl(options);

  const hooks: Hooks = {
    config: async (config: Config) => {
      config.mcp ??= {};
      if (!config.mcp[BLACKBOX_MCP_NAME]) {
        config.mcp[BLACKBOX_MCP_NAME] = {
          type: "remote",
          url,
          enabled: true,
        };
      }
    },
    "experimental.chat.system.transform": async (_input, output) => {
      if (!output.system.includes(BLACKBOX_SYSTEM_PROMPT)) {
        output.system.push(BLACKBOX_SYSTEM_PROMPT);
      }
    },
  };

  return hooks;
};

/**
 * OpenCode V1 plugin shape (`{ id, server }`).
 * Required so file:// installs do not fall through to legacy export scanning.
 */
export default {
  id: "softprobe-blackbox",
  server: BlackboxPlugin,
};
