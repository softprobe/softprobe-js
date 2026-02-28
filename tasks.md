# Softprobe Delivery Tracker — CLI Capture + Cursor Skills

Implementation rule per task:
1. implement the smallest change for the active task
2. validate only with Softprobe CLI flows (`capture` / `diff`) as the testing method
3. skip TDD and do not add or require red/green unit-test cycles for task completion
4. mark `[x]` with short commit-style note
5. continue to the next first unchecked task automatically (no stop-between-tasks), unless blocked by a required human decision

> Do not implement ahead of the first unchecked task. Execute in strict order.

---

## Legend
- `[ ]` not started
- `[x]` completed (append short commit-style note)

---

## 1) Capture CLI

- [x] **Task 1.1 Add `softprobe capture` command that invokes curl** — `feat(cli): add capture command that wraps curl with Softprobe headers`
  - **Goal**: provide a first-class CLI command that sends a request with Softprobe capture headers (`x-softprobe-mode: CAPTURE`, `x-softprobe-trace-id`) and supports method/body/custom headers.
  - **Verification**: run `softprobe capture ...` and confirm request reaches target with capture headers applied.

## 2) Cursor Skills Packaging

- [x] **Task 2.1 Add Cursor Skill assets (`SKILL.md` + command templates)** — `feat(skill): add softprobe Cursor skill with capture/diff/demo templates`
  - **Goal**: provide reusable Cursor Skill instructions and copy-paste command templates for capture/replay/diff workflows.
  - **Verification**: skill folder contains `SKILL.md` and templates for capture + diff runbook commands.

## 3) Onboarding Docs

- [x] **Task 3.1 Document Cursor integration and skill installation** — `docs(cursor): add skill install steps and capture/diff template usage`
  - **Goal**: explain exactly how to install this repo’s Softprobe Skill into Cursor and run it with the global CLI.
  - **Verification**: README includes a “Cursor Skills” section with setup steps and template usage instructions.

## 4) Portable Skill Knowledge Bundle

- [x] **Task 4.1 Package portable Softprobe knowledge docs for external repos** — `docs(skill): bundle portable product spec and constraints for cross-repo Cursor skill installs`
  - **Goal**: ensure users installing the skill outside this repository get explicit Softprobe architecture and operation knowledge.
  - **Verification**: `cursor-skills/softprobe/docs` contains product spec, architecture contract, workflow contract, compatibility matrix, and do-not-infer guidance; `SKILL.md` requires reading these docs.
- [x] **Task 4.2 Add anti-misuse integration runbook and no-deep-import guardrails** — `docs(skill): add canonical bootstrap runbook and forbid internal dist import workarounds`
  - **Goal**: prevent agents from misintegrating Softprobe by path-importing internal package files or guessing middleware wiring.
  - **Verification**: skill docs include required preflight checks, explicit forbidden patterns, and canonical `@softprobe/softprobe-js/init` bootstrap flow.
- [x] **Task 4.3 Require OTel NodeSDK startup in canonical skill integration flow** — `docs(skill): require NodeSDK init/start after softprobe init in integration runbook`
  - **Goal**: prevent partial integrations where Softprobe is loaded but OpenTelemetry runtime is never started.
  - **Verification**: runbook and skill prerequisites explicitly require `NodeSDK` + `getNodeAutoInstrumentations()` + `sdk.start()` and preflight checks assert presence.
