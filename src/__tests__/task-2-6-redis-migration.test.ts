import fs from 'node:fs';
import path from 'node:path';

describe('task 2.6 - redis instrumentation migration', () => {
  const srcRoot = path.resolve(__dirname, '..');

  it('keeps redis implementation only under instrumentation package', async () => {
    const newCapture = path.join(srcRoot, 'instrumentations/redis/capture.ts');
    const newReplay = path.join(srcRoot, 'instrumentations/redis/replay.ts');
    const legacyCapture = path.join(srcRoot, 'capture/redis.ts');
    const legacyReplay = path.join(srcRoot, 'replay/redis.ts');

    expect(fs.existsSync(newCapture)).toBe(true);
    expect(fs.existsSync(newReplay)).toBe(true);
    expect(fs.existsSync(legacyCapture)).toBe(false);
    expect(fs.existsSync(legacyReplay)).toBe(false);

    const packageCapture = await import(path.join(srcRoot, 'instrumentations/redis/capture'));
    const packageReplay = await import(path.join(srcRoot, 'instrumentations/redis/replay'));

    expect(typeof packageCapture.buildRedisResponseHook).toBe('function');
    expect(typeof packageReplay.setupRedisReplay).toBe('function');
    expect(typeof packageReplay.applyRedisReplay).toBe('function');
  });
});
