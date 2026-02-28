# Softprobe Do-Not-Infer Rules

Agents using this skill must not infer or invent behavior outside declared design/task docs.

## Never Infer

- hidden fallback modes when matching fails
- automatic cassette path discovery beyond configured directory + trace id
- protocol support not explicitly implemented
- new runtime flags/options not requested by the user
- middleware behavior when headers are absent or invalid

## Always Ask

Ask the user before proceeding when:

- target repo lacks clear Softprobe init ordering
- cassette storage strategy is undocumented
- strict replay policy is ambiguous
- expected protocol instrumentation is missing

## Response Discipline

- state assumptions explicitly
- keep output tied to observed files/commands
- if blocked, report exact missing input and stop
