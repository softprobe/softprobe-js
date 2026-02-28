# Softprobe Compatibility Matrix

This matrix defines current baseline expectations for portable usage.

## Runtime

- Node.js: supported (primary target)
- Browser runtimes: out of scope

## Protocol Targets

- HTTP: supported
- Postgres: supported
- Redis: supported
- Other protocols (AMQP/gRPC/etc.): only if explicitly implemented in target repo

## Required Platform Pieces

- OpenTelemetry context available
- Softprobe init loaded before OTel auto-instrumentation
- OTel NodeSDK initialized and started in bootstrap
- Request middleware/interceptor that can read coordination headers
- Cassette directory configured and writable by process

## CLI

- `softprobe capture`: requires `curl` available in runtime environment
- `softprobe diff`: requires cassette file with at least one inbound record

## Notes

If target repo differs from this matrix, treat the gap as unsupported until the user confirms a custom design.
