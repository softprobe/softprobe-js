import fs from 'node:fs';
import path from 'node:path';

describe('task 2.6 - redis instrumentation migration', () => {
  const srcRoot = path.resolve(__dirname, '..');

  it('moves redis capture/replay implementation under instrumentation package', async () => {
    const newCapture = path.join(srcRoot, 'instrumentations/redis/capture.ts');
    const newReplay = path.join(srcRoot, 'instrumentations/redis/replay.ts');

    expect(fs.existsSync(newCapture)).toBe(true);
    expect(fs.existsSync(newReplay)).toBe(true);

    const legacyCapture = await import(path.join(srcRoot, 'capture/redis'));
    const legacyReplay = await import(path.join(srcRoot, 'replay/redis'));
    const packageCapture = await import(path.join(srcRoot, 'instrumentations/redis/capture'));
    const packageReplay = await import(path.join(srcRoot, 'instrumentations/redis/replay'));

    expect(legacyCapture.buildRedisResponseHook).toBe(packageCapture.buildRedisResponseHook);
    expect(legacyReplay.setupRedisReplay).toBe(packageReplay.setupRedisReplay);
    expect(legacyReplay.applyRedisReplay).toBe(packageReplay.applyRedisReplay);
  });
});
