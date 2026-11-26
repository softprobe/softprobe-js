import { afterEach, describe, expect, it, vi } from "vitest";
import pluginModule, {
  BLACKBOX_MCP_NAME,
  BLACKBOX_SYSTEM_PROMPT,
  DEFAULT_BLACKBOX_MCP_URL,
  resolveBlackboxMcpUrl,
} from "./index.js";

type McpServerConfig = {
  type: "remote";
  url: string;
  disabled?: boolean;
};

type McpEditor = {
  get(name: string): McpServerConfig | undefined;
  set(name: string, config: McpServerConfig): void;
};

type ContextSystemEvent = {
  system: Array<{ type: "text"; text: string }>;
};

type ContextHandler = (event: ContextSystemEvent) => void;

type PluginContext = {
  options: { url?: unknown };
  mcp: {
    transform(callback: (editor: McpEditor) => void): Promise<unknown>;
  };
  session: {
    hook(name: "context", callback: ContextHandler): Promise<unknown>;
  };
};

type OpenCodePlugin = {
  id: string;
  setup(context: PluginContext): Promise<void>;
};

const originalEnvUrl = process.env.BLACKBOX_MCP_URL;
const plugin = pluginModule as OpenCodePlugin;

function createPluginContext(input: {
  options?: PluginContext["options"];
  existingServer?: McpServerConfig;
} = {}) {
  const servers = new Map<string, McpServerConfig>();
  if (input.existingServer) servers.set(BLACKBOX_MCP_NAME, input.existingServer);

  const editor: McpEditor = {
    get: (name) => servers.get(name),
    set: (name, config) => servers.set(name, config),
  };
  let contextHandler: ContextHandler | undefined;
  const transform = vi.fn(async (callback: (editor: McpEditor) => void) => {
    callback(editor);
  });
  const hook = vi.fn(async (_name: "context", callback: ContextHandler) => {
    contextHandler = callback;
  });
  const context: PluginContext = {
    options: input.options ?? {},
    mcp: { transform },
    session: { hook },
  };

  return { context, servers, transform, hook, getContextHandler: () => contextHandler };
}

afterEach(() => {
  if (originalEnvUrl === undefined) {
    delete process.env.BLACKBOX_MCP_URL;
  } else {
    process.env.BLACKBOX_MCP_URL = originalEnvUrl;
  }
});

describe("@softprobe/opencode-blackbox", () => {
  it("exports the OpenCode v2 plugin definition", () => {
    expect(pluginModule).toEqual({
      id: "softprobe-blackbox",
      setup: expect.any(Function),
    });
  });

  it("registers the default remote MCP server through the OpenCode MCP transform", async () => {
    delete process.env.BLACKBOX_MCP_URL;
    const test = createPluginContext();

    await plugin.setup(test.context);

    expect(test.transform).toHaveBeenCalledTimes(1);
    expect(test.servers.get(BLACKBOX_MCP_NAME)).toEqual({
      type: "remote",
      url: DEFAULT_BLACKBOX_MCP_URL,
    });
  });

  it("uses BLACKBOX_MCP_URL when set", async () => {
    process.env.BLACKBOX_MCP_URL = "https://explorer-staging.softprobe.ai/mcp";
    const test = createPluginContext();

    await plugin.setup(test.context);

    expect(test.servers.get(BLACKBOX_MCP_NAME)).toEqual({
      type: "remote",
      url: "https://explorer-staging.softprobe.ai/mcp",
    });
  });

  it("prefers the plugin url option over BLACKBOX_MCP_URL and ignores blank values", async () => {
    process.env.BLACKBOX_MCP_URL = "https://env.example.com/mcp";
    expect(resolveBlackboxMcpUrl({ url: "https://opt.example.com/mcp" })).toBe(
      "https://opt.example.com/mcp",
    );
    expect(resolveBlackboxMcpUrl({ url: "   " })).toBe(
      "https://env.example.com/mcp",
    );

    const test = createPluginContext({ options: { url: "https://opt.example.com/mcp" } });
    await plugin.setup(test.context);

    expect(test.servers.get(BLACKBOX_MCP_NAME)?.url).toBe(
      "https://opt.example.com/mcp",
    );
  });

  it("preserves an existing user-configured blackbox MCP server", async () => {
    const customServer: McpServerConfig = {
      type: "remote",
      url: "https://custom.example.com/mcp",
      disabled: true,
    };
    const test = createPluginContext({ existingServer: customServer });

    await plugin.setup(test.context);

    expect(test.servers.get(BLACKBOX_MCP_NAME)).toBe(customServer);
  });

  it("adds Blackbox prompt guidance once to OpenCode context", async () => {
    const test = createPluginContext();

    await plugin.setup(test.context);

    expect(test.hook).toHaveBeenCalledWith("context", expect.any(Function));
    const contextHandler = test.getContextHandler();
    expect(contextHandler).toBeDefined();
    const event: ContextSystemEvent = {
      system: [{ type: "text", text: "base system prompt" }],
    };
    contextHandler?.(event);
    contextHandler?.(event);

    expect(event.system).toHaveLength(2);
    expect(event.system[1]?.text).toBe(BLACKBOX_SYSTEM_PROMPT);
    expect(BLACKBOX_SYSTEM_PROMPT).toContain("get_session_semantic_actions");
    expect(BLACKBOX_SYSTEM_PROMPT).toContain("get_trace");
    expect(BLACKBOX_SYSTEM_PROMPT).toContain("@playwright/test");
    expect(BLACKBOX_SYSTEM_PROMPT).toContain("@softprobe/e2e/playwright");
    expect(BLACKBOX_SYSTEM_PROMPT).toContain("@softprobe/e2e/mobile");
    expect(BLACKBOX_SYSTEM_PROMPT).toContain("Maestro (`.yaml`)");
    expect(BLACKBOX_SYSTEM_PROMPT).toContain("bootstrap_project");
  });
});
