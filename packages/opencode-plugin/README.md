# Softprobe OpenCode plugin

OpenCode plugin that maps coding-agent sessions to Softprobe OTLP observations
(`agent` → `generation` → `tool`) using [`@softprobe/tracing`](../tracing).

Full message and tool payloads are always captured so sessions can be evaluated
and used to improve agents.

## Install

Full guide: [Agent QA · OpenCode](https://docs.softprobe.ai/en/agent-qa/opencode)
(Explorer can also give you a short pasteable OpenCode chat prompt).

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
  "ingestionKey": "<Ingestion Key>",
  "otlp": {
    "tracesEndpoint": "https://explorer-staging.softprobe.ai/api/thelake/v1/traces",
    "protocol": "http/protobuf"
  },
  "resourceAttributes": { "deployment.environment.name": "staging" },
  "environment": "staging",
  "userId": "your-user-id"
}
```

`ingestionKey` is required. `otlp.tracesEndpoint` is the exact trace destination;
`otlp.endpoint` is a generic base URL and gets `/v1/traces` appended. `baseUrl`
routes score API calls only. It never changes the trace destination. If no OTLP
endpoint is configured, traces default to
`https://explorer.softprobe.ai/api/thelake/v1/traces`.
Credential parsing and validation use shared helpers from
`@softprobe/tracing` (`resolveSoftprobeConfigFromEnv`, etc.); this package only
adds the OpenCode config file path and soft-disable behavior when credentials are
missing. When both `spcode` and `opencode` credential files exist, **spcode wins**.

Or set standard OTLP environment variables. These settings configure server-side
export; `SOFTPROBE_BASE_URL` also selects where score writes go:

```bash
export INGESTION_KEY="..."
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT="https://explorer-staging.softprobe.ai/api/thelake/v1/traces"
export OTEL_EXPORTER_OTLP_TRACES_HEADERS="Authorization=Bearer ${INGESTION_KEY}"
export OTEL_EXPORTER_OTLP_TRACES_PROTOCOL="http/protobuf"
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment.name=staging"
export SOFTPROBE_USER_ID="your-user-id"
```

Explicit fields in the credential file override environment values. Environment
values fill fields omitted from the file. `SOFTPROBE_BASE_URL` only routes
score API calls. Without an OTLP endpoint, the SDK uses the production trace URL
shown above.

Softprobe **spcode** product builds auto-inject this plugin and default thelake
credentials when `SPCODE_MODE` is on (see softprobe-code
`softprobe-llm-defaults.ts`).

## What is traced

- User turns (`opencode.turn` / `agent`) with prompt text
- Model generations with completions, usage, and cost
- Tool executions with arguments and results (`gen_ai.tool.*` / `sp.tool.*`)
- Retries, reasoning, compaction events
- Failed steps and session errors / aborts

### Sub-agent sessions

OpenCode runs sub-agents (the `task` tool) in child OpenCode sessions. The
plugin nests each child turn under the dispatching task span (`parent_span_id`)
and stamps the **root** OpenCode session id as `sp.session.id` /
`gen_ai.conversation.id` on every nested span — one product Session for the
whole chat. Child `ses_*` ids stay internal to the plugin graph and are never
the product session key. Linkage comes from the task part's
`state.metadata.sessionId` (authoritative), with `task_id` resume and
parentID + task-call inference as fallbacks; ambiguous dispatches (e.g.
parallel identical task calls) are left unnested rather than guessed. Nested
turns also carry `sp.metadata.opencode.parentSessionID` /
`sp.metadata.opencode.parentTaskCallID`, and the task span records
`sp.child.session.id` for the OpenCode child session id.

Session lifecycle is isolated per session: a sub-agent session going idle
finalizes only its own spans, never the parent session's in-flight work.

See [Coding agents](../../docs/integrations/coding-agents.md).
