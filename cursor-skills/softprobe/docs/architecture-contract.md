# Softprobe Architecture Contract

Use these constraints when applying Softprobe in any codebase.

## OpenTelemetry Ordering

- `softprobe/init` must run before OpenTelemetry auto-instrumentation wraps dependency modules.
- Softprobe stores state using a dedicated OpenTelemetry context key.

## Dependency Direction

- Shared core/foundation code must not depend on package-specific instrumentation.
- Instrumentation packages can depend on foundation and shared protocol helpers.
- One instrumentation package must not depend on another instrumentation package.

## Cassette Ownership

- Cassette instances are created in context setup flow only.
- Middleware/wrappers must use active context; they do not construct cassettes.
- One cassette file per trace id: `{cassetteDirectory}/{traceId}.ndjson`.

## Replay Flow Contract

1. Resolve active mode and trace id.
2. Resolve cassette for that trace.
3. Load records once per replay scope.
4. Seed matcher for wrapper/interceptor decisions.

## Wrapper Contract

- Wrappers/interceptors provide span attributes for matcher key extraction.
- On no match, wrappers decide behavior (strict failure vs dev passthrough).
- Matcher remains pure selection logic.
