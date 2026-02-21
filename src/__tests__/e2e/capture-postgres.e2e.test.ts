/**
 * Phase 7 E2E: Task 7.4 – Postgres contract alignment.
 * Uses Testcontainers to run a real Postgres; asserts Postgres spans have
 * softprobe.protocol, identifier, request/response body and content match.
 * Requires Docker (or compatible container runtime); test fails if unavailable.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { initCapture } from '../../capture/init';
import { applyAutoInstrumentationMutator } from '../../capture/mutator';

const TRACES_FILE = path.join(os.tmpdir(), `softprobe-e2e-postgres-${Date.now()}-traces.json`);

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

  beforeAll(async () => {
    pgContainer = await new PostgreSqlContainer('postgres:16').start();
    process.env.PG_URL = pgContainer.getConnectionUri();
    process.env.SOFTPROBE_TRACES_FILE = TRACES_FILE;
    initCapture();
    applyAutoInstrumentationMutator();
  }, 60000);

  afterAll(async () => {
    await pgContainer?.stop();
    delete process.env.PG_URL;
    delete process.env.SOFTPROBE_TRACES_FILE;
    if (fs.existsSync(TRACES_FILE)) fs.unlinkSync(TRACES_FILE);
  });

  it('7.4: Postgres spans have protocol, identifier, request/response body; content matches', async () => {
    if (fs.existsSync(TRACES_FILE)) fs.unlinkSync(TRACES_FILE);

    process.env.SOFTPROBE_TRACES_FILE = TRACES_FILE;
    const { NodeSDK } = require('@opentelemetry/sdk-node');
    const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
    const sdk = new NodeSDK({ instrumentations: getNodeAutoInstrumentations() });
    sdk.start();
    const { Client } = require('pg');

    const client = new Client({ connectionString: process.env.PG_URL });
    await client.connect();

    const queryText = 'SELECT 1 AS num, $1::text AS label';
    const values = ['e2e-softprobe'];
    const result = await client.query(queryText, values);
    await client.end();

    await new Promise((r) => setTimeout(r, 800));
    await sdk.shutdown();

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
    expect(parsedRes.rows).toEqual(result.rows);
    expect(parsedRes.rowCount).toBe(result.rowCount);
  }, 15000);
});
