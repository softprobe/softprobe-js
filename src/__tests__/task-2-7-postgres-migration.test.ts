import fs from 'node:fs';
import path from 'node:path';

describe('task 2.7 - postgres instrumentation migration', () => {
  const srcRoot = path.resolve(__dirname, '..');

  it('moves postgres capture/replay implementation under instrumentation package', async () => {
    const newCapture = path.join(srcRoot, 'instrumentations/postgres/capture.ts');
    const newReplay = path.join(srcRoot, 'instrumentations/postgres/replay.ts');

    expect(fs.existsSync(newCapture)).toBe(true);
    expect(fs.existsSync(newReplay)).toBe(true);

    const legacyCapture = await import(path.join(srcRoot, 'capture/postgres'));
    const legacyReplay = await import(path.join(srcRoot, 'replay/postgres'));
    const packageCapture = await import(path.join(srcRoot, 'instrumentations/postgres/capture'));
    const packageReplay = await import(path.join(srcRoot, 'instrumentations/postgres/replay'));

    expect(legacyCapture.buildPostgresRequestHook).toBe(packageCapture.buildPostgresRequestHook);
    expect(legacyCapture.buildPostgresResponseHook).toBe(packageCapture.buildPostgresResponseHook);
    expect(legacyReplay.setupPostgresReplay).toBe(packageReplay.setupPostgresReplay);
    expect(legacyReplay.applyPostgresReplay).toBe(packageReplay.applyPostgresReplay);
  });
});
