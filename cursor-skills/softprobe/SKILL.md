# Softprobe Capture/Replay Skill

Use this skill when validating backend behavior with recorded traffic.

## Prerequisites

- Global CLI installed: `npm install -g @softprobe/softprobe-js`
- Target app runs with Softprobe init + middleware and cassette directory configured

## Inputs

- `TARGET_URL`: service URL (for example `http://127.0.0.1:3000`)
- `ROUTE`: path/query to capture (for example `/price?sku=coffee-beans`)
- `TRACE_ID`: deterministic trace id
- `CASSETTE`: cassette path (for example `./cassettes/<TRACE_ID>.ndjson`)

## Workflow

1. Capture baseline request
2. Replay and diff against target
3. Report PASS/FAIL and mismatched fields

## Commands

Use templates in `templates/`:

- `templates/capture.sh` for capture request
- `templates/diff.sh` for replay comparison
- `templates/demo-pricing.sh` for end-to-end pricing regression demo

## Output format

When reporting results in Cursor, keep this structure:

- `Result`: PASS or FAIL
- `Trace`: trace id used
- `Cassette`: resolved cassette file path
- `Mismatch`: list path + recorded/live values (if FAIL)
