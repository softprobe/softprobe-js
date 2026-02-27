/**
 * Task 12.2.1: Child worker for Postgres NDJSON cassette capture E2E.
 * Loads softprobe/init (CAPTURE) first; runs one pg query inside SoftprobeContext.run
 * with cassetteDirectory + traceId so capture writes to {cassetteDirectory}/{traceId}.ndjson.
 *
 * Env: SOFTPROBE_CONFIG_PATH (or legacy SOFTPROBE_CASSETTE_PATH via run-child YAML), PG_URL
 * Stdout: JSON { rows, rowCount } from the query (for optional assertions).
 */

import path from 'path';
import { ConfigManager } from '../../../config/config-manager';
import { softprobe } from '../../../api';

const initPath = path.join(__dirname, '..', '..', '..', 'init.ts');
require(initPath);

async function main() {
  const configPath = process.env.SOFTPROBE_CONFIG_PATH ?? './.softprobe/config.yml';
  let cassetteDirectory: string | undefined;
  let traceId: string | undefined;
  try {
    const cfg = new ConfigManager(configPath).get() as {
      cassetteDirectory?: string;
      traceId?: string;
      cassettePath?: string;
    };
    cassetteDirectory = cfg.cassetteDirectory;
    traceId = cfg.traceId;
    if (!cassetteDirectory || !traceId) {
      const fromPath = cfg.cassettePath;
      if (typeof fromPath === 'string' && fromPath) {
        cassetteDirectory = path.dirname(fromPath);
        traceId = path.basename(fromPath, '.ndjson');
      }
    }
  } catch {
    cassetteDirectory = undefined;
    traceId = undefined;
  }
  if (!cassetteDirectory || !traceId) {
    throw new Error('cassetteDirectory + traceId or cassettePath is required in config');
  }

  const { NodeSDK } = require('@opentelemetry/sdk-node');
  const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');

  const sdk = new NodeSDK({ instrumentations: getNodeAutoInstrumentations() });
  sdk.start();

  const { Client } = require('pg');
  const client = new Client({ connectionString: process.env.PG_URL });
  await client.connect();

  const queryText = 'SELECT 1 AS num, $1::text AS label';
  const values = ['e2e-cassette'];
  const result = await softprobe.run(
    { mode: 'CAPTURE', traceId, cassetteDirectory },
    async () => client.query(queryText, values)
  );
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
