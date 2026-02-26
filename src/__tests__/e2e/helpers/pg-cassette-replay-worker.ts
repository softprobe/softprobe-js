/**
 * Task 12.2.2: Child worker for Postgres NDJSON replay E2E (DB disconnected).
 * Loads softprobe/init (REPLAY), then runWithContext with cassette; runs pg query
 * which is mocked from the cassette — no real DB connection.
 *
 * Env: SOFTPROBE_CONFIG_PATH
 * Stdout: JSON { rows, rowCount } from replayed query.
 */

import path from 'path';
import { runSoftprobeScope } from '../../helpers/run-softprobe-scope';
import { ConfigManager } from '../../../config/config-manager';

const initPath = path.join(__dirname, '..', '..', '..', 'init.ts');
require(initPath);

async function main() {
  const { NodeSDK } = require('@opentelemetry/sdk-node');
  const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
  const sdk = new NodeSDK({ instrumentations: getNodeAutoInstrumentations() });
  sdk.start();

  const configPath = process.env.SOFTPROBE_CONFIG_PATH ?? './.softprobe/config.yml';
  let cassettePath = '';
  try {
    cassettePath = new ConfigManager(configPath).get().cassettePath ?? '';
  } catch {
    cassettePath = '';
  }
  if (!cassettePath) {
    process.stderr.write('cassettePath is required in config');
    process.exit(1);
  }

  await runSoftprobeScope({ cassettePath }, async () => {
    const { Client } = require('pg');
    const client = new Client({ connectionString: process.env.PG_URL || 'postgres://localhost:9999/nodb' });
    const queryText = 'SELECT 1 AS num, $1::text AS label';
    const values = ['e2e-cassette'];
    const result = await client.query(queryText, values);
    process.stdout.write(JSON.stringify({ rows: result.rows, rowCount: result.rowCount }));
  });

  try {
    await sdk.shutdown();
  } catch {
    /* ignore */
  }
}

main().catch((err) => {
  process.stderr.write(err.stack ?? String(err));
  process.exit(1);
});
