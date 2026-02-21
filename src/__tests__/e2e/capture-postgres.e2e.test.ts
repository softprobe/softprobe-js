/**
 * Phase 7 E2E: Task 7.4 – Postgres contract alignment.
 * Uses Testcontainers to run a real Postgres; asserts Postgres spans have
 * softprobe.protocol, identifier, request/response body and content match.
 *
 * The actual capture runs in a child process (pg-capture-worker.ts) because
 * Jest's module system bypasses require-in-the-middle, preventing OTel from
 * instrumenting the pg module inside a Jest test.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';

const TRACES_FILE = path.join(os.tmpdir(), `softprobe-e2e-postgres-${Date.now()}-traces.json`);
const WORKER_SCRIPT = path.join(__dirname, 'helpers', 'pg-capture-worker.ts');

interface SerializedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name?: string;
  attributes: Record<string, unknown>;
}

type TraceStore = Record<string, SerializedSpan[]>;

function loadTraceStore(): TraceStore {
  const raw = fs.readFileSync(TRACES_FILE, 'utf-8');
  return JSON.parse(raw) as TraceStore;
}

function getPostgresSpans(store: TraceStore): SerializedSpan[] {
  return Object.values(store)
    .flat()
    .filter((s) => s.attributes && s.attributes['softprobe.protocol'] === 'postgres');
}

describe('E2E capture – Postgres (Task 7.4)', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let queryResult: { rows: Record<string, unknown>[]; rowCount: number };

  beforeAll(async () => {
    pgContainer = await new PostgreSqlContainer('postgres:16').start();

    if (fs.existsSync(TRACES_FILE)) fs.unlinkSync(TRACES_FILE);

    const stdout = execSync(`npx ts-node ${WORKER_SCRIPT}`, {
      env: {
        ...process.env,
        PG_URL: pgContainer.getConnectionUri(),
        SOFTPROBE_TRACES_FILE: TRACES_FILE,
      },
      timeout: 30_000,
      encoding: 'utf-8',
    });
    queryResult = JSON.parse(stdout);
  }, 60000);

  afterAll(async () => {
    await pgContainer?.stop();
    if (fs.existsSync(TRACES_FILE)) fs.unlinkSync(TRACES_FILE);
  });

  it('7.4: Postgres spans have protocol, identifier, request/response body; content matches', () => {
    expect(fs.existsSync(TRACES_FILE)).toBe(true);
    const store = loadTraceStore();
    const pgSpans = getPostgresSpans(store);
    expect(pgSpans.length).toBeGreaterThanOrEqual(1);

    for (const span of pgSpans) {
      expect(span.attributes['softprobe.protocol']).toBe('postgres');
      const identifier = span.attributes['softprobe.identifier'];
      expect(identifier).toBeDefined();
      expect(typeof identifier).toBe('string');
      expect((identifier as string).length).toBeGreaterThan(0);
      const responseBody = span.attributes['softprobe.response.body'];
      expect(responseBody).toBeDefined();
      const parsed = JSON.parse(responseBody as string);
      expect(parsed).toHaveProperty('rows');
      expect(Array.isArray(parsed.rows)).toBe(true);
    }

    const queryText = 'SELECT 1 AS num, $1::text AS label';
    const values = ['e2e-softprobe'];

    const span = pgSpans.find((s) => (s.attributes['softprobe.identifier'] as string)?.includes('SELECT'));
    expect(span).toBeDefined();
    expect(span!.attributes['softprobe.identifier']).toBe(queryText);

    const reqBody = span!.attributes['softprobe.request.body'];
    expect(reqBody).toBeDefined();
    const parsedReq = JSON.parse(reqBody as string);
    expect(parsedReq).toHaveProperty('text', queryText);
    expect(parsedReq).toHaveProperty('values', values);

    const resBody = span!.attributes['softprobe.response.body'];
    const parsedRes = JSON.parse(resBody as string);
    expect(parsedRes.rows).toEqual(queryResult.rows);
    expect(parsedRes.rowCount).toBe(queryResult.rowCount);
  });
});
