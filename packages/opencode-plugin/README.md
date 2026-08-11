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

### Sub-agent sessions

OpenCode runs sub-agents (the `task` tool) in child sessions. The plugin nests
each child session's turn under the dispatching task span, so a whole agent
run — root session plus any sub-agents, recursively — forms a single trace
instead of several disconnected ones. The link comes from the task part's
`state.metadata.sessionId` (authoritative), with `task_id` resume and
parentID + task-call inference as fallbacks; ambiguous dispatches (e.g.
parallel identical task calls) are left unnested rather than guessed. Each
span keeps its own `sp.session.id`; the parent side is recorded as
`sp.metadata.opencode.parentSessionID` / `sp.metadata.opencode.parentTaskCallID`
on the child turn and `sp.child.session.id` on the task span.

Session lifecycle is isolated per session: a sub-agent session going idle
finalizes only its own spans, never the parent session's in-flight work.

See [Coding agents](../../docs/integrations/coding-agents.md).

## Evaluator integration (Phase 1)

The evaluator service can pass an optional `evaluation` context to
`createSoftprobeSessionTracer` (or `SoftprobeSessionTracer`). The plugin uses
the existing session graph to mark the configured root and task-created
verifier children, then propagates `evaluationId`, `sopId`, `sopVersion`, and
`sourceTraceId` as `sp.metadata.*` on evaluator observations. Subject sessions
without an evaluator role are left unchanged.

The existing `tool.execute.before` boundary can enforce an optional
`allowedTools` list in evaluator sessions. Scorecards are captured with
`tracer.traceScorecard(sessionID, output)` as the existing event observation
`opencode.evaluation.scorecard`; malformed and missing output is recorded with
`scorecardStatus` rather than scored or repaired.

Reasoning/orchestration, SOP execution, generic scoring, and a scorecard
protocol are not implemented by this plugin. Those capabilities remain in the
evaluator service.
