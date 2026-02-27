import type { Cassette } from '../types/schema';
import { resolveRequestStorage } from '../core/cassette/request-storage';

describe('request-storage', () => {
  it('throws when neither configured storage nor cassetteDirectory + traceId is provided', () => {
    expect(() => resolveRequestStorage({})).toThrow(
      'Softprobe cassette storage is not configured. Provide configured storage or cassetteDirectory + traceId.'
    );
  });

  it('uses cassetteDirectory + traceId when provided', async () => {
    const cassetteDir = __dirname;
    const traceId = 'request-storage-trace';
    const { storage } = resolveRequestStorage({
      cassetteDirectory: cassetteDir,
      traceId,
    });
    const records = await storage.loadTrace();
    expect(Array.isArray(records)).toBe(true);
  });

  it('uses configured storage when provided', async () => {
    const configuredStorage: Cassette = {
      loadTrace: async () => [],
      saveRecord: async () => {},
    };
    const { storage } = resolveRequestStorage({
      configuredCassette: configuredStorage,
    });
    expect(storage).toBe(configuredStorage);
  });

  it('prefers existing cassette over configured cassette', () => {
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
});
