# Softprobe Capture/Replay Skill

Use this skill when validating backend behavior with recorded traffic.

## Required Read Order

Before executing any Softprobe task in any repository, read:

1. `docs/softprobe-spec.md`
2. `docs/architecture-contract.md`
3. `docs/integration-runbook.md`
4. `docs/workflow-contract.md`
5. `docs/compatibility-matrix.md`
6. `docs/do-not-infer.md`

Do not guess behavior outside these docs. If required details are missing in the target repo, stop and ask.

## Prerequisites

- Global CLI installed: `npm install -g @softprobe/softprobe-js`
- Target bootstrap loads `@softprobe/softprobe-js/init`, initializes OTel NodeSDK, and calls `sdk.start()`
- Cassette directory configured in `.softprobe/config.yml`

## Critical Integration Rules

- Prefer `node -r ./instrumentation.js server.js` with bootstrap that loads `@softprobe/softprobe-js/init` and starts OTel NodeSDK.
- Do not deep import internal package files such as `@softprobe/softprobe-js/dist/...`.
- Do not add manual middleware imports unless there is an explicit public export and user request.
- If init ordering or config is unclear, stop and ask instead of guessing.

## Inputs

- `TARGET_URL`: service URL (for example `http://127.0.0.1:3000`)
- `ROUTE`: path/query to capture (for example `/price?sku=coffee-beans`)
- `TRACE_ID`: deterministic trace id
- `CASSETTE`: cassette path (for example `./cassettes/<TRACE_ID>.ndjson`)

## Workflow

1. Run integration preflight from `docs/integration-runbook.md`.
2. Capture baseline request.
3. Replay and diff against target.
4. Report PASS/FAIL and mismatched fields.

## Commands

Use templates in `templates/`:

- `templates/capture.sh` for capture request
- `templates/diff.sh` for replay comparison
- `templates/demo-pricing.sh` for end-to-end pricing regression demo

## Output Format

When reporting results, keep this structure:

- `Result`: PASS or FAIL
- `Trace`: trace id used
- `Cassette`: resolved cassette file path
- `Mismatch`: list path + recorded/live values (if FAIL)
