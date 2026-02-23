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
});
