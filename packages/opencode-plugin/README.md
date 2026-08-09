# Softprobe OpenCode plugin

OpenCode plugin that maps coding-agent sessions to Softprobe OTLP observations
(`agent` → `generation` → `tool`) using [`@softprobe/tracing`](../tracing).

Full message and tool payloads are always captured so sessions can be evaluated
and used to improve agents.

## Install

Enable OpenTelemetry and add the plugin in `opencode.json` / `opencode.jsonc`:

```json
{
  "experimental": {
    "openTelemetry": true
  },
  "plugin": ["@softprobe/opencode-plugin@latest"]
}
```

Restart OpenCode after changing the config.

## Credentials

Create `opencode-softprobe.json` in the OpenCode / spcode global config directory:

- spcode: `$XDG_CONFIG_HOME/spcode` (or `~/.config/spcode`)
- OpenCode: `$XDG_CONFIG_HOME/opencode` (or `~/.config/opencode`)
- Override directory with `OPENCODE_CONFIG_DIR`

```json
{
  "publicKey": "<softprobe-bearer-token>",
  "baseUrl": "https://thelake.softprobe.ai",
  "otlpEndpoint": "https://thelake.softprobe.ai/v1/traces",
  "environment": "production",
  "userId": "your-user-id"
}
```

`publicKey` and `baseUrl` are required. `otlpEndpoint` defaults to
`{baseUrl}/v1/traces`. Credential parsing and validation use shared helpers from
`@softprobe/tracing` (`resolveSoftprobeConfigFromEnv`, etc.); this package only
adds the OpenCode config file path and soft-disable behavior when credentials are
missing. When both `spcode` and `opencode` credential files exist, **spcode wins**.

Or set environment variables (env wins when both key and base URL are set):

```bash
export SOFTPROBE_PUBLIC_KEY="..."
export SOFTPROBE_BASE_URL="https://thelake.softprobe.ai"
export SOFTPROBE_OTLP_ENDPOINT="https://thelake.softprobe.ai/v1/traces"
export SOFTPROBE_ENVIRONMENT="production"
export SOFTPROBE_USER_ID="your-user-id"
```

Softprobe **spcode** product builds auto-inject this plugin and default thelake
credentials when `SPCODE_MODE` is on (see softprobe-code
`softprobe-llm-defaults.ts`).

## What is traced

- User turns (`opencode.turn` / `agent`) with prompt text
- Model generations with completions, usage, and cost
- Tool executions with arguments and results (`gen_ai.tool.*` / `sp.tool.*`)
- Retries, reasoning, compaction events
- Failed steps and session errors / aborts

MCP tools: OpenCode currently fires `tool.execute.after` with the raw MCP
`CallToolResult` (`{ content: [...] }`) before it normalizes to
`{ title, output }`. This plugin waits for `message.part.updated` (completed)
in that case so `sp.output` gets the truncated `part.state.output` instead of
`"{}"`.

See [Coding agents](../../docs/integrations/coding-agents.md).
