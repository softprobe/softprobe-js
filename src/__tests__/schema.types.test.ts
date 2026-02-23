/**
 * V4.1 schema types tests (Protocol, RecordType, SoftprobeCassetteRecord, isCassetteRecord).
 */
import type { Protocol, RecordType, SoftprobeCassetteRecord } from '../types/schema';
import { isCassetteRecord } from '../types/schema';

describe('schema.types (V4.1)', () => {
  describe('Protocol', () => {
    /** Compile-time: Protocol = "http" | "postgres" | "redis" | "amqp" | "grpc". */
    const allProtocols: Protocol[] = ['http', 'postgres', 'redis', 'amqp', 'grpc'];

    it('is union type "http" | "postgres" | "redis" | "amqp" | "grpc"', () => {
      expect(allProtocols).toHaveLength(5);
      expect(allProtocols).toContain('http');
      expect(allProtocols).toContain('postgres');
      expect(allProtocols).toContain('redis');
      expect(allProtocols).toContain('amqp');
      expect(allProtocols).toContain('grpc');
    });
  });

  describe('RecordType', () => {
    /** Compile-time: RecordType = "inbound" | "outbound" | "metadata". */
    const allRecordTypes: RecordType[] = ['inbound', 'outbound', 'metadata'];

    it('is union type "inbound" | "outbound" | "metadata"', () => {
      expect(allRecordTypes).toHaveLength(3);
      expect(allRecordTypes).toContain('inbound');
      expect(allRecordTypes).toContain('outbound');
      expect(allRecordTypes).toContain('metadata');
    });
  });

  describe('SoftprobeCassetteRecord', () => {
    const requiredKeys = ['version', 'traceId', 'spanId', 'timestamp', 'type', 'protocol', 'identifier'] as const;

    it('has version literal "4.1"', () => {
      const record: SoftprobeCassetteRecord = {
        version: '4.1',
        traceId: 't1',
        spanId: 's1',
        timestamp: '2025-01-01T00:00:00.000Z',
        type: 'outbound',
        protocol: 'http',
        identifier: 'GET https://example.com/',
      };
      expect(record.version).toBe('4.1');
    });

    it('has all required keys', () => {
      const record: SoftprobeCassetteRecord = {
        version: '4.1',
        traceId: 't1',
        spanId: 's1',
        timestamp: '2025-01-01T00:00:00.000Z',
        type: 'outbound',
        protocol: 'postgres',
        identifier: 'SELECT 1',
      };
      for (const key of requiredKeys) {
        expect(record).toHaveProperty(key);
      }
    });
  });

  describe('isCassetteRecord', () => {
    it('returns true for valid record with version 4.1', () => {
      const record: SoftprobeCassetteRecord = {
        version: '4.1',
        traceId: 't1',
        spanId: 's1',
        timestamp: '2025-01-01T00:00:00.000Z',
        type: 'outbound',
        protocol: 'http',
        identifier: 'GET /',
      };
      expect(isCassetteRecord(record)).toBe(true);
    });

    it('returns false when version is missing', () => {
      expect(isCassetteRecord({ traceId: 't1', spanId: 's1' })).toBe(false);
      expect(isCassetteRecord({})).toBe(false);
    });
  });
});
