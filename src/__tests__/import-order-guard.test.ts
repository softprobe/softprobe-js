/**
 * Task 9.1.1: Import-order guard (pg).
 * Detect OTel-wrapped pg query and throw fatal so user must import softprobe/init before OTel.
 */

import { setupPostgresReplay } from '../replay/postgres';

describe('Import-order guard (pg)', () => {
  it('throws when pg.Client.prototype.query is already marked __wrapped (OTel wrapped first)', () => {
    const pg = require('pg');
    (pg.Client.prototype.query as { __wrapped?: boolean }).__wrapped = true;

    expect(() => setupPostgresReplay()).toThrow(
      /import .*softprobe\/init.*BEFORE OTel/i
    );

    // Restore so other test files are not affected if they run in same process
    delete (pg.Client.prototype.query as { __wrapped?: boolean }).__wrapped;
  });

  it('Task 8.3: boot import throws when pg query was wrapped before softprobe init in REPLAY mode', () => {
    jest.isolateModules(() => {
      jest.doMock('../config/config-manager', () => ({
        ConfigManager: class {
          get() {
            return { mode: 'REPLAY', cassettePath: '' };
          }
        },
      }));
      jest.doMock('pg', () => {
        function Client(this: unknown) {}
        (Client as unknown as { prototype: { query: () => void } }).prototype.query = () => undefined;
        (Client as unknown as { prototype: { query: { __wrapped?: boolean } } }).prototype.query.__wrapped = true;
        return { Client };
      });
      expect(() => require('../init')).toThrow(/import .*softprobe\/init.*BEFORE OTel/i);
    });
  });
});
