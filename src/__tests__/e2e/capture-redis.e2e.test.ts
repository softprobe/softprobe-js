/**
 * Phase 7 E2E: Task 7.3 – Redis contract alignment.
 * Uses Testcontainers to run a real Redis; asserts Redis spans have
 * softprobe.protocol, identifier, request/response body and content match.
 * Requires Docker (or compatible container runtime); test fails if unavailable.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { initCapture } from '../../capture/init';
import { applyAutoInstrumentationMutator } from '../../capture/mutator';

const TRACES_FILE = path.join(os.tmpdir(), `softprobe-e2e-redis-${Date.now()}-traces.json`);

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

function getRedisSpans(store: TraceStore): SerializedSpan[] {
  return Object.values(store)
    .flat()
    .filter((s) => s.attributes && s.attributes['softprobe.protocol'] === 'redis');
}

describe('E2E capture – Redis (Task 7.3)', () => {
  let redisContainer: StartedRedisContainer;

  beforeAll(async () => {
    redisContainer = await new RedisContainer('redis:7').start();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();
    process.env.SOFTPROBE_TRACES_FILE = TRACES_FILE;
    initCapture();
    applyAutoInstrumentationMutator();
  }, 30000);

  afterAll(async () => {
    await redisContainer?.stop();
    delete process.env.REDIS_URL;
    delete process.env.SOFTPROBE_TRACES_FILE;
    if (fs.existsSync(TRACES_FILE)) fs.unlinkSync(TRACES_FILE);
  });

  it('7.3: Redis spans have protocol, identifier, request/response body; content matches', async () => {
    if (fs.existsSync(TRACES_FILE)) fs.unlinkSync(TRACES_FILE);

    process.env.SOFTPROBE_TRACES_FILE = TRACES_FILE;
    const { NodeSDK } = require('@opentelemetry/sdk-node');
    const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
    const sdk = new NodeSDK({ instrumentations: getNodeAutoInstrumentations() });
    sdk.start();
    const { createClient } = require('redis');

    const client = createClient({ url: process.env.REDIS_URL });
    await client.connect();

    const key = `softprobe:e2e:${Date.now()}`;
    const value = 'redis-e2e-value';
    await client.set(key, value);
    const reply = await client.get(key);
    await client.quit();

    await new Promise((r) => setTimeout(r, 800));
    await sdk.shutdown();

    expect(fs.existsSync(TRACES_FILE)).toBe(true);
    const store = loadTraceStore();
    const redisSpans = getRedisSpans(store);
    expect(redisSpans.length).toBeGreaterThanOrEqual(1);

    for (const span of redisSpans) {
      expect(span.attributes['softprobe.protocol']).toBe('redis');
      const identifier = span.attributes['softprobe.identifier'];
      expect(identifier).toBeDefined();
      expect(typeof identifier).toBe('string');
      expect((identifier as string).length).toBeGreaterThan(0);
    }

    const setSpan = redisSpans.find((s) => (s.attributes['softprobe.identifier'] as string)?.startsWith('SET'));
    expect(setSpan).toBeDefined();
    const setReqBody = setSpan!.attributes['softprobe.request.body'];
    expect(setReqBody).toBeDefined();
    const setParsedReq = JSON.parse(setReqBody as string);
    expect(Array.isArray(setParsedReq)).toBe(true);
    expect(setParsedReq).toContain(key);
    expect(setParsedReq).toContain(value);
    expect(setSpan!.attributes['softprobe.response.body']).toBeDefined();

    const getSpan = redisSpans.find((s) => (s.attributes['softprobe.identifier'] as string)?.startsWith('GET'));
    expect(getSpan).toBeDefined();
    const getReqBody = getSpan!.attributes['softprobe.request.body'];
    expect(getReqBody).toBeDefined();
    expect(JSON.parse(getReqBody as string)).toEqual([key]);
    const getResBody = getSpan!.attributes['softprobe.response.body'];
    expect(getResBody).toBeDefined();
    expect(JSON.parse(getResBody as string)).toBe(reply);
  }, 15000);
});
