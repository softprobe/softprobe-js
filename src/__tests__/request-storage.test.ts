import type { Cassette } from '../types/schema';
import {
  readCassettePathHeader,
  resolveRequestStorage,
} from '../core/cassette/request-storage';

describe('request-storage', () => {
  it('throws when neither header path nor configured storage is provided', () => {
    expect(() => resolveRequestStorage({})).toThrow(
      'Softprobe cassette storage is not configured. Provide x-softprobe-cassette-path or configured storage.'
    );
  });

  it('uses header cassette path when provided', async () => {
    const { storage, cassettePathHeader } = resolveRequestStorage({
      headers: { 'x-softprobe-cassette-path': '/from-header.ndjson' },
    });
    expect(cassettePathHeader).toBe('/from-header.ndjson');
    await expect(storage.loadTrace()).rejects.toBeDefined();
  });

  it('uses configured storage when header path is absent', async () => {
    const configuredStorage: Cassette = {
      loadTrace: async () => [],
      saveRecord: async () => {},
    };
    const { storage } = resolveRequestStorage({
      configuredCassette: configuredStorage,
    });
    expect(storage).toBe(configuredStorage);
  });

  it('prefers existing cassette over configured cassette when header is absent', () => {
    const existing: Cassette = {
      loadTrace: async () => [],
      saveRecord: async () => {},
    };
    const configured: Cassette = {
      loadTrace: async () => [{ version: '4.1', traceId: 'x', spanId: 'y', timestamp: '1', type: 'outbound', protocol: 'http', identifier: 'GET /' }],
      saveRecord: async () => {},
    };
    const { storage } = resolveRequestStorage({
      existingCassette: existing,
      configuredCassette: configured,
    });
    expect(storage).toBe(existing);
  });

  it('extracts cassette header value from string or first array entry', () => {
    expect(readCassettePathHeader({ 'x-softprobe-cassette-path': '/a.ndjson' })).toBe('/a.ndjson');
    expect(readCassettePathHeader({ 'x-softprobe-cassette-path': ['/b.ndjson', '/c.ndjson'] })).toBe('/b.ndjson');
  });

});
