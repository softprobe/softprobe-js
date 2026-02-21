/**
 * Child-process worker for Postgres E2E capture.
 * Runs outside Jest so OTel require-in-the-middle hooks can instrument pg.
 *
 * Env:   PG_URL, SOFTPROBE_TRACES_FILE
 * Stdout: JSON with { rows, rowCount } from the test query.
 *
 * Note: OTEL_TRACES_EXPORTER must NOT be "none" — that disables span
 * recording entirely, preventing any exporter (including ours) from seeing spans.
 */

import { initCapture } from '../../../capture/init';
import { applyAutoInstrumentationMutator } from '../../../capture/mutator';

initCapture();
applyAutoInstrumentationMutator();

async function main() {
  const { NodeSDK } = require('@opentelemetry/sdk-node');
  const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');

  const sdk = new NodeSDK({ instrumentations: getNodeAutoInstrumentations() });
  sdk.start();

  const { Client } = require('pg');
  const client = new Client({ connectionString: process.env.PG_URL });
  await client.connect();

  const queryText = 'SELECT 1 AS num, $1::text AS label';
  const values = ['e2e-softprobe'];
  const result = await client.query(queryText, values);
  await client.end();

  await new Promise((r) => setTimeout(r, 1000));
  try { await sdk.shutdown(); } catch { /* OTLP collector not running — expected */ }

  process.stdout.write(JSON.stringify({ rows: result.rows, rowCount: result.rowCount }));
}

main().catch((err) => {
  process.stderr.write(err.stack ?? String(err));
  process.exit(1);
});
