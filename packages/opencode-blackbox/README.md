# @softprobe/opencode-blackbox

OpenCode plugin that registers the Softprobe Blackbox remote HTTP MCP server (`blackbox`) and adds Blackbox usage guidance to OpenCode chat sessions.

For sending OpenCode session telemetry to Softprobe, use [`@softprobe/opencode-plugin`](../opencode-plugin) instead.

## Install

Add the plugin with the OpenCode CLI. This installs it globally:

```bash
opencode plugin add @softprobe/opencode-blackbox
```

## Authenticate

Authenticate with the `blackbox` MCP server:

```bash
opencode mcp auth blackbox
```

If `opencode mcp list` says no servers are configured immediately after setup, run it again after OpenCode starts its service. A `needs authentication` status confirms that `blackbox` is registered.

## Configuration

By default, the plugin registers the remote MCP server at `https://explorer.softprobe.ai/mcp`.

To point at another Softprobe Explorer instance, set `BLACKBOX_MCP_URL`:

```bash
export BLACKBOX_MCP_URL="https://explorer-staging.softprobe.ai/mcp"
```

Or pass `url` in the plugin options in `opencode.json`:

```json
{
  "plugins": [
    {
      "package": "@softprobe/opencode-blackbox",
      "options": {
        "url": "https://explorer-staging.softprobe.ai/mcp"
      }
    }
  ]
}
```

To configure the MCP server directly instead, run this from the project where you want to use Blackbox, then authenticate:

```bash
opencode mcp add blackbox --url https://explorer.softprobe.ai/mcp
opencode mcp auth blackbox
```
