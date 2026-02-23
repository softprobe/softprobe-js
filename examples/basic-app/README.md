# Basic-app example (user-facing demo)

Express app with **real** Postgres, Redis, and outbound HTTP. Uses **OpenTelemetry**; you can add Softprobe later (import `softprobe/init` first).

## Prerequisites

- Node.js (project dependencies installed: `npm install`)
- Docker (for Postgres and Redis)

## Run the app (real connections)

1. Start Postgres and Redis:

   ```bash
   # from repo root
   npm run example:up
   ```

2. Start the server (default port 3000):

   ```bash
   npm run example:run
   ```

   Then open or curl `http://localhost:3000/` — you get JSON with `postgres`, `redis`, and `http` fields.

3. Stop services when done:

   ```bash
   npm run example:down
   ```

The app uses default URLs that match the example docker-compose (`PG_URL`, `REDIS_URL`, `PORT`). Override with env vars if your setup differs.

## Tests

Tests live **inside this example** (not in softprobe production code). From repo root:

```bash
npm run example:test
```

Uses Testcontainers for Postgres and Redis; no need to start Docker first.
