/**
 * Task 1.4 type test: ensure SoftprobeCassetteRecord identity fields are required.
 */
import type { SoftprobeCassetteRecord } from '../types/schema';

describe('SoftprobeCassetteRecord identity', () => {
  const record: SoftprobeCassetteRecord = {
    version: '4.1',
    traceId: 'trace-1',
    spanId: 'span-1',
    timestamp: '2025-02-25T00:00:00.000Z',
    type: 'outbound',
    protocol: 'http',
    identifier: 'GET https://example.com/',
  };

  it('requires version', () => {
    const { version, ...rest } = record;
    // @ts-expect-error missing version
    const missingVersion: SoftprobeCassetteRecord = rest;
    expect(missingVersion).toBeDefined();
  });

  it('requires traceId', () => {
    const { traceId, ...rest } = record;
    // @ts-expect-error missing traceId
    const missingTraceId: SoftprobeCassetteRecord = rest;
    expect(missingTraceId).toBeDefined();
  });

  it('requires spanId', () => {
    const { spanId, ...rest } = record;
    // @ts-expect-error missing spanId
    const missingSpanId: SoftprobeCassetteRecord = rest;
    expect(missingSpanId).toBeDefined();
  });

  it('requires timestamp', () => {
    const { timestamp, ...rest } = record;
    // @ts-expect-error missing timestamp
    const missingTimestamp: SoftprobeCassetteRecord = rest;
    expect(missingTimestamp).toBeDefined();
  });

  it('requires type', () => {
    const { type, ...rest } = record;
    // @ts-expect-error missing type
    const missingType: SoftprobeCassetteRecord = rest;
    expect(missingType).toBeDefined();
  });

  it('requires protocol', () => {
    const { protocol, ...rest } = record;
    // @ts-expect-error missing protocol
    const missingProtocol: SoftprobeCassetteRecord = rest;
    expect(missingProtocol).toBeDefined();
  });

  it('requires identifier', () => {
    const { identifier, ...rest } = record;
    // @ts-expect-error missing identifier
    const missingIdentifier: SoftprobeCassetteRecord = rest;
    expect(missingIdentifier).toBeDefined();
  });
});
