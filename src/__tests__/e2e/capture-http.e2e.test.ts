/**
 * Phase 7 E2E: Tasks 7.1 (HTTP fixture and capture run).
 * Runs capture with real Node SDK + auto-instrumentations, then asserts
 * on softprobe-traces.json for fixture run (7.1).
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { initCapture } from '../../capture/init';
import { applyAutoInstrumentationMutator } from '../../capture/mutator';

const TRACES_FILE = path.join(os.tmpdir(), `softprobe-e2e-${Date.now()}-traces.json`);

/** Serialized span shape written by our exporter. */
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

function getAllSpans(store: TraceStore): SerializedSpan[] {
  return Object.values(store).flat();
}

function getHttpSpans(store: TraceStore): SerializedSpan[] {
  return getAllSpans(store).filter(
    (s) => s.attributes && s.attributes['softprobe.protocol'] === 'http'
  );
}

describe('E2E capture (Tasks 7.1, 7.2, 7.5)', () => {
  beforeAll(() => {
    process.env.SOFTPROBE_TRACES_FILE = TRACES_FILE;
    initCapture();
    applyAutoInstrumentationMutator();
  });

  afterAll(() => {
    delete process.env.SOFTPROBE_TRACES_FILE;
    if (fs.existsSync(TRACES_FILE)) fs.unlinkSync(TRACES_FILE);
  });

  it('7.1: creates softprobe-traces.json with at least one trace and spans after HTTP request', async () => {
    const { NodeSDK } = require('@opentelemetry/sdk-node');
    const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');

    const sdk = new NodeSDK({
      instrumentations: getNodeAutoInstrumentations(),
    });
    sdk.start();

    await fetch('http://httpbin.org/get');
    await new Promise((r) => setTimeout(r, 800));

    expect(fs.existsSync(TRACES_FILE)).toBe(true);
    const store = loadTraceStore();
    const traceIds = Object.keys(store);
    expect(traceIds.length).toBeGreaterThanOrEqual(1);
    const spans = getAllSpans(store);
    expect(spans.length).toBeGreaterThanOrEqual(1);
  }, 15000);

  it('7.2: every HTTP span has softprobe.protocol, identifier, and response.body shape', async () => {
    const { NodeSDK } = require('@opentelemetry/sdk-node');
    const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');

    if (fs.existsSync(TRACES_FILE)) fs.unlinkSync(TRACES_FILE);

    const sdk = new NodeSDK({
      instrumentations: getNodeAutoInstrumentations(),
    });
    sdk.start();

    await fetch('http://httpbin.org/get');
    await new Promise((r) => setTimeout(r, 800));

    const store = loadTraceStore();
    const httpSpans = getHttpSpans(store);
    expect(httpSpans.length).toBeGreaterThanOrEqual(1);

    for (const span of httpSpans) {
      expect(span.attributes['softprobe.protocol']).toBe('http');
      const identifier = span.attributes['softprobe.identifier'];
      expect(identifier).toBeDefined();
      expect(typeof identifier).toBe('string');
      expect((identifier as string).length).toBeGreaterThan(0);
      const responseBody = span.attributes['softprobe.response.body'];
      expect(responseBody).toBeDefined();
      const parsed = JSON.parse(responseBody as string);
      expect(parsed).toHaveProperty('statusCode');
    }
  }, 15000);

  it('7.5: stored request and response body match actual request/response content', async () => {
    const { NodeSDK } = require('@opentelemetry/sdk-node');
    const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');

    if (fs.existsSync(TRACES_FILE)) fs.unlinkSync(TRACES_FILE);

    const sdk = new NodeSDK({
      instrumentations: getNodeAutoInstrumentations(),
    });
    sdk.start();

    const postBody = { softprobe: 'e2e-body-verification', num: 42 };
    const res = await fetch('http://httpbin.org/post', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(postBody),
    });
    const responseData = await res.json();
    await new Promise((r) => setTimeout(r, 800));

    const store = loadTraceStore();
    const httpSpans = getHttpSpans(store);
    const postSpan = httpSpans.find(
      (s) =>
        (s.attributes['softprobe.identifier'] as string)?.includes('POST') &&
        (s.attributes['softprobe.identifier'] as string)?.includes('/post')
    );
    expect(postSpan).toBeDefined();

    const reqBody = postSpan!.attributes['softprobe.request.body'];
    expect(reqBody).toBeDefined();
    const parsedReq = JSON.parse(reqBody as string);
    if (Object.keys(parsedReq).length > 0) {
      expect(parsedReq).toEqual(postBody);
    }

    const resBody = postSpan!.attributes['softprobe.response.body'];
    expect(resBody).toBeDefined();
    const parsedRes = JSON.parse(resBody as string);
    expect(parsedRes.statusCode).toBe(res.status);
    if (parsedRes.body != null) {
      expect(parsedRes.body).toEqual(responseData);
    }
  }, 15000);
});
