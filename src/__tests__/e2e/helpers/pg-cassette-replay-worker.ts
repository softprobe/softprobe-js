/**
 * Task 12.2.2: Child worker for Postgres NDJSON replay E2E (DB disconnected).
 * Loads softprobe/init (REPLAY), then runs query under softprobe.run(REPLAY) with NdjsonCassette;
 * which is mocked from the cassette — no real DB connection.
 *
 * Env: SOFTPROBE_CONFIG_PATH, REPLAY_TRACE_ID
 * Stdout: JSON { rows, rowCount } from replayed query.
 */

import path from 'path';
import { ConfigManager } from '../../../config/config-manager';
import { softprobe } from '../../../api';
import { NdjsonCassette } from '../../../core/cassette/ndjson-cassette';

const initPath = path.join(__dirname, '..', '..', '..', 'init.ts');
require(initPath);

async function main() {
  const { NodeSDK } = require('@opentelemetry/sdk-node');
  const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
  const sdk = new NodeSDK({ instrumentations: getNodeAutoInstrumentations() });
  sdk.start();

  const configPath = process.env.SOFTPROBE_CONFIG_PATH ?? './.softprobe/config.yml';
  const replayTraceId = process.env.REPLAY_TRACE_ID ?? 'pg-replay-e2e';
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
  const storage = new NdjsonCassette(cassettePath);

  let output: { rows: unknown[]; rowCount: number } | undefined;
  await softprobe.run(
    {
      mode: 'REPLAY',
      traceId: replayTraceId,
      storage,
    },
    async () => {
    const { Client } = require('pg');
    const client = new Client({ connectionString: process.env.PG_URL || 'postgres://localhost:9999/nodb' });
    const queryText = 'SELECT 1 AS num, $1::text AS label';
    const values = ['e2e-cassette'];
    const result = await client.query(queryText, values);
    output = { rows: result.rows, rowCount: result.rowCount };
    }
  );

  try {
    await sdk.shutdown();
  } catch {
    /* ignore */
  }
  process.stdout.write(JSON.stringify(output ?? { rows: [], rowCount: 0 }));
}

main().catch((err) => {
  process.stderr.write(err.stack ?? String(err));
  process.exit(1);
});
