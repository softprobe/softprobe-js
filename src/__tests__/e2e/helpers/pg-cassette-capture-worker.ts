/**
 * Task 12.2.1: Child worker for Postgres NDJSON cassette capture E2E.
 * Loads softprobe/init (CAPTURE) first so CassetteStore is set; runs one pg query;
 * on exit the store flushes and NDJSON is written.
 *
 * Env: SOFTPROBE_MODE=CAPTURE, SOFTPROBE_CASSETTE_PATH, PG_URL
 * Stdout: JSON { rows, rowCount } from the query (for optional assertions).
 */

import path from 'path';

// Must load init first so CAPTURE branch runs and sets CassetteStore (absolute path for ts-node)
const initPath = path.join(__dirname, '..', '..', '..', 'init.ts');
require(initPath);

async function main() {
  const { NodeSDK } = require('@opentelemetry/sdk-node');
  const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');

  const sdk = new NodeSDK({ instrumentations: getNodeAutoInstrumentations() });
  sdk.start();

  const { Client } = require('pg');
  const client = new Client({ connectionString: process.env.PG_URL });
  await client.connect();

  const queryText = 'SELECT 1 AS num, $1::text AS label';
  const values = ['e2e-cassette'];
  const result = await client.query(queryText, values);
  await client.end();

  await new Promise((r) => setTimeout(r, 500));
  try {
    await sdk.shutdown();
  } catch {
    /* OTLP collector not running — expected */
  }

  process.stdout.write(JSON.stringify({ rows: result.rows, rowCount: result.rowCount }));
}

main().catch((err) => {
  process.stderr.write(err.stack ?? String(err));
  process.exit(1);
});
