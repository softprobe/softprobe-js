# @softprobe/opencode-blackbox

OpenCode plugin that registers the Softprobe Blackbox remote HTTP MCP server (`blackbox`) and adds Blackbox usage guidance to OpenCode chat sessions.

For sending OpenCode session telemetry to Softprobe, use [`@softprobe/opencode-plugin`](../opencode-plugin) instead.

## Install

Add the plugin with the OpenCode CLI:

```bash
opencode plugin add @softprobe/opencode-blackbox
```

## Authenticate

Authenticate with the `blackbox` MCP server:

```bash
opencode mcp auth blackbox
```

## Configuration

By default, the plugin registers the remote MCP server at `https://explorer.softprobe.ai/mcp`.

To point at another Softprobe Explorer instance, set `BLACKBOX_MCP_URL`:

```bash
export BLACKBOX_MCP_URL="https://explorer-staging.softprobe.ai/mcp"
```

Or pass `url` via plugin options in `opencode.json`:

```json
{
  "plugin": [
    ["@softprobe/opencode-blackbox", { "url": "https://explorer-staging.softprobe.ai/mcp" }]
  ]
}
```
