# Softprobe Skill Workflow Contract

This is the execution contract for agents using this skill in external repositories.

## Required Sequence

1. Read product docs in the required order from `SKILL.md`.
2. Confirm target repository has initialization and middleware wiring for Softprobe headers.
3. Run capture with explicit `TRACE_ID`.
4. Run replay comparison (`softprobe diff`) against the target service.
5. Report result with trace id, cassette path, and mismatch details.

## Verification Standard

- For CLI tasks, validate using actual `softprobe capture` / `softprobe diff` flows.
- Do not claim success from static inspection alone when runtime verification is expected.

## Change Scope

- Keep edits minimal and local to requested task.
- Do not introduce runtime features/options not present in project design docs.
- If requirements conflict with target-repo architecture, pause and request user decision.

## Failure Policy

- Fail fast on missing required values (`TRACE_ID`, target URL, cassette path).
- Surface clear errors; do not silently fallback to guessed behavior.
