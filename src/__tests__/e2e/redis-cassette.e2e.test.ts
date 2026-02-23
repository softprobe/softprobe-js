/**
 * Task 12.3 Redis E2E:
 * - 12.3.1 CAPTURE writes NDJSON
 * - 12.3.2 REPLAY works without redis
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { runChild } from './run-child';
import { loadNdjson } from '../../store/load-ndjson';
import type { SoftprobeCassetteRecord } from '../../types/schema';

const CAPTURE_WORKER = path.join(__dirname, 'helpers', 'redis-cassette-capture-worker.ts');
const REPLAY_WORKER = path.join(__dirname, 'helpers', 'redis-replay-worker.ts');

function getRedisOutboundRecords(records: SoftprobeCassetteRecord[]): SoftprobeCassetteRecord[] {
  return records.filter((r) => r.type === 'outbound' && r.protocol === 'redis');
}

describe('E2E Redis cassette capture/replay (Task 12.3)', () => {
  let redisContainer: StartedRedisContainer;
  let cassettePath: string;
  let redisKey: string;
  let redisValue: string;

  beforeAll(async () => {
    redisContainer = await new RedisContainer('redis:7').start();
    cassettePath = path.join(
      os.tmpdir(),
      `softprobe-e2e-cassette-redis-${Date.now()}.ndjson`
    );
    redisKey = `softprobe:e2e:${Date.now()}`;
    redisValue = 'redis-e2e-value';
    if (fs.existsSync(cassettePath)) fs.unlinkSync(cassettePath);
  }, 60000);

  afterAll(async () => {
    await redisContainer?.stop();
    if (fs.existsSync(cassettePath)) fs.unlinkSync(cassettePath);
  });

  it('12.3.1: CAPTURE writes NDJSON', async () => {
    const result = runChild(
      CAPTURE_WORKER,
      {
        SOFTPROBE_MODE: 'CAPTURE',
        SOFTPROBE_CASSETTE_PATH: cassettePath,
        REDIS_URL: redisContainer.getConnectionUrl(),
        REDIS_KEY: redisKey,
        REDIS_VALUE: redisValue,
      },
      { useTsNode: true }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');

    expect(fs.existsSync(cassettePath)).toBe(true);
    const records = await loadNdjson(cassettePath);
    const redisRecords = getRedisOutboundRecords(records);
    expect(redisRecords.length).toBeGreaterThanOrEqual(1);

    const getRecord = redisRecords.find((r) => r.identifier === `GET ${redisKey}`);
    expect(getRecord).toBeDefined();
    expect(getRecord?.responsePayload).toBe(redisValue);
  }, 60000);

  it('12.3.2: REPLAY works without redis', async () => {
    await redisContainer.stop();

    const result = runChild(
      REPLAY_WORKER,
      {
        SOFTPROBE_MODE: 'REPLAY',
        SOFTPROBE_CASSETTE_PATH: cassettePath,
        SOFTPROBE_STRICT_REPLAY: '1',
        REDIS_KEY: redisKey,
      },
      { useTsNode: true }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');

    const replayResult = JSON.parse(result.stdout) as { value: string };
    expect(replayResult.value).toBe(redisValue);
  }, 60000);
});
