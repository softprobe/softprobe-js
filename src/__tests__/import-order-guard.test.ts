/**
 * Task 9.1.1: Import-order guard (pg).
 * When OTel has already wrapped pg (e.g. after sdk.start()), we wrap on top instead of throwing.
 */

import { setupPostgresReplay } from '../instrumentations/postgres/replay';

describe('Import-order guard (pg)', () => {
  it('does not throw when pg.Client.prototype.query is already __wrapped (wraps on top)', () => {
    const pg = require('pg');
    (pg.Client.prototype.query as { __wrapped?: boolean }).__wrapped = true;

    expect(() => setupPostgresReplay()).not.toThrow();

    // Restore so other test files are not affected if they run in same process
    delete (pg.Client.prototype.query as { __wrapped?: boolean }).__wrapped;
  });

  it('Task 8.3: init does not throw when pg query was wrapped before init (unified init wraps on top)', () => {
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
      expect(() => require('../init')).not.toThrow();
    });
  });
});
