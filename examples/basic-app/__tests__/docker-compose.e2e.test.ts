/**
 * E2E test for Task 16.1.3: docker-compose brings up Postgres + Redis;
 * npm run example:run (or equivalent) connects and returns JSON.
 *
 * Requires Docker. Skipped when Docker is not available (e.g. CI without docker-compose).
 */

import path from 'path';
import net from 'net';
import { spawnSync } from 'child_process';
import { runServer, waitForServer } from './run-child';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const COMPOSE_FILE = path.join(REPO_ROOT, 'examples', 'basic-app', 'docker-compose.yml');
const RUN_SCRIPT = path.join(__dirname, '..', 'run.ts');
const INSTRUMENTATION = path.join(__dirname, '..', 'instrumentation.ts');
const PORT = 39300;

function dockerComposeAvailable(): boolean {
  const r = spawnSync('docker', ['compose', 'version'], {
    encoding: 'utf-8',
    cwd: REPO_ROOT,
  });
  return r.status === 0;
}

function waitForPort(host: string, port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryConnect = () => {
      const socket = new net.Socket();
      socket.setTimeout(500);
      socket.on('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.on('error', () => {
        if (Date.now() - start >= timeoutMs) reject(new Error(`Port ${port} not ready in ${timeoutMs}ms`));
        else setTimeout(tryConnect, 500);
      });
      socket.on('timeout', () => {
        socket.destroy();
        if (Date.now() - start >= timeoutMs) reject(new Error(`Port ${port} not ready in ${timeoutMs}ms`));
        else setTimeout(tryConnect, 500);
      });
      socket.connect(port, host);
    };
    tryConnect();
  });
}

const dockerAvailable = dockerComposeAvailable();
(dockerAvailable ? describe : describe.skip)('Docker Compose demo (16.1.3)', () => {
  beforeAll(async () => {
    const up = spawnSync('docker', ['compose', '-f', COMPOSE_FILE, 'up', '-d'], {
      encoding: 'utf-8',
      cwd: REPO_ROOT,
    });
    if (up.status !== 0) {
      throw new Error(`docker compose up -d failed: ${up.stderr}`);
    }
    await Promise.all([
      waitForPort('127.0.0.1', 5432, 30000),
      waitForPort('127.0.0.1', 6379, 30000),
    ]);
  }, 60000);

  afterAll(() => {
    spawnSync('docker', ['compose', '-f', COMPOSE_FILE, 'down'], {
      encoding: 'utf-8',
      cwd: REPO_ROOT,
    });
  });

  it('docker compose up -d brings services up; example:run connects and prints JSON', async () => {
    const child = runServer(
      RUN_SCRIPT,
      {
        PORT: String(PORT),
        PG_URL: process.env.PG_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres',
        REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
      },
      { useTsNode: true, require: INSTRUMENTATION }
    );

    try {
      await waitForServer(PORT, 15000);
      const res = await fetch(`http://127.0.0.1:${PORT}/`);
      expect(res.ok).toBe(true);

      const json = (await res.json()) as Record<string, unknown>;
      expect(json).toHaveProperty('postgres');
      expect(json).toHaveProperty('redis');
      expect(json).toHaveProperty('http');
    } finally {
      child.kill();
    }
  });
});
