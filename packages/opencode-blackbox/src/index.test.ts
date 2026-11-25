import { afterEach, describe, expect, it } from "vitest";
import type { Config, PluginInput } from "@opencode-ai/plugin";
import pluginModule, {
  BLACKBOX_MCP_NAME,
  BLACKBOX_SYSTEM_PROMPT,
  BlackboxPlugin,
  DEFAULT_BLACKBOX_MCP_URL,
  resolveBlackboxMcpUrl,
} from "./index.js";

const originalEnvUrl = process.env.BLACKBOX_MCP_URL;

afterEach(() => {
  if (originalEnvUrl === undefined) {
    delete process.env.BLACKBOX_MCP_URL;
  } else {
    process.env.BLACKBOX_MCP_URL = originalEnvUrl;
  }
});

describe("@softprobe/opencode-blackbox", () => {
  it("exports OpenCode V1 plugin shape", () => {
    expect(pluginModule).toEqual({
      id: "softprobe-blackbox",
      server: BlackboxPlugin,
    });
  });

  it("registers the blackbox remote MCP server with the default URL", async () => {
    delete process.env.BLACKBOX_MCP_URL;
    const hooks = await BlackboxPlugin({} as PluginInput);
    const config: Config = {};

    await hooks.config?.(config);

    expect(config.mcp?.[BLACKBOX_MCP_NAME]).toEqual({
      type: "remote",
      url: DEFAULT_BLACKBOX_MCP_URL,
      enabled: true,
    });
  });

  it("uses BLACKBOX_MCP_URL when set", async () => {
    process.env.BLACKBOX_MCP_URL = "https://explorer-staging.softprobe.ai/mcp";
    const hooks = await BlackboxPlugin({} as PluginInput);
    const config: Config = {};

    await hooks.config?.(config);

    expect(config.mcp?.[BLACKBOX_MCP_NAME]).toEqual({
      type: "remote",
      url: "https://explorer-staging.softprobe.ai/mcp",
      enabled: true,
    });
  });

  it("prefers plugin options.url over BLACKBOX_MCP_URL and ignores blank values", () => {
    process.env.BLACKBOX_MCP_URL = "   ";
    expect(resolveBlackboxMcpUrl()).toBe(DEFAULT_BLACKBOX_MCP_URL);

    process.env.BLACKBOX_MCP_URL = "https://env.example.com/mcp";
    expect(resolveBlackboxMcpUrl({ url: "https://opt.example.com/mcp" })).toBe(
      "https://opt.example.com/mcp",
    );
  });

  it("preserves an existing user-configured blackbox MCP entry", async () => {
    const hooks = await BlackboxPlugin({} as PluginInput);
    const customConfig = {
      type: "remote" as const,
      url: "https://custom.example.com/mcp",
      enabled: false,
    };
    const config: Config = {
      mcp: {
        [BLACKBOX_MCP_NAME]: customConfig,
      },
    };

    await hooks.config?.(config);

    expect(config.mcp?.[BLACKBOX_MCP_NAME]).toBe(customConfig);
  });

  it("injects Blackbox prompt guidance once into system prompts", async () => {
    const hooks = await BlackboxPlugin({} as PluginInput);
    const output = { system: ["base system prompt"] };
    const transform = hooks["experimental.chat.system.transform"];

    expect(transform).toBeDefined();
    await transform?.(
      { model: {} as Parameters<NonNullable<typeof transform>>[0]["model"] },
      output,
    );
    await transform?.(
      { model: {} as Parameters<NonNullable<typeof transform>>[0]["model"] },
      output,
    );

    expect(output.system).toEqual([
      "base system prompt",
      BLACKBOX_SYSTEM_PROMPT,
    ]);
    expect(BLACKBOX_SYSTEM_PROMPT).toContain("get_session_semantic_actions");
    expect(BLACKBOX_SYSTEM_PROMPT).toContain("get_trace");
    expect(BLACKBOX_SYSTEM_PROMPT).toContain("@playwright/test");
    expect(BLACKBOX_SYSTEM_PROMPT).toContain("@softprobe/e2e/playwright");
    expect(BLACKBOX_SYSTEM_PROMPT).toContain("@softprobe/e2e/mobile");
    expect(BLACKBOX_SYSTEM_PROMPT).toContain("Maestro (`.yaml`)");
    expect(BLACKBOX_SYSTEM_PROMPT).toContain("bootstrap_project");
  });
});
