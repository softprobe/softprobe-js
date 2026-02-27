import fs from 'node:fs';
import path from 'node:path';

describe('task 2.7 - postgres instrumentation migration', () => {
  const srcRoot = path.resolve(__dirname, '..');

  it('keeps postgres implementation only under instrumentation package', async () => {
    const newCapture = path.join(srcRoot, 'instrumentations/postgres/capture.ts');
    const newReplay = path.join(srcRoot, 'instrumentations/postgres/replay.ts');
    const legacyCapture = path.join(srcRoot, 'capture/postgres.ts');
    const legacyReplay = path.join(srcRoot, 'replay/postgres.ts');

    expect(fs.existsSync(newCapture)).toBe(true);
    expect(fs.existsSync(newReplay)).toBe(true);
    expect(fs.existsSync(legacyCapture)).toBe(false);
    expect(fs.existsSync(legacyReplay)).toBe(false);

    const packageCapture = await import(path.join(srcRoot, 'instrumentations/postgres/capture'));
    const packageReplay = await import(path.join(srcRoot, 'instrumentations/postgres/replay'));

    expect(typeof packageCapture.buildPostgresRequestHook).toBe('function');
    expect(typeof packageCapture.buildPostgresResponseHook).toBe('function');
    expect(typeof packageReplay.setupPostgresReplay).toBe('function');
    expect(typeof packageReplay.applyPostgresReplay).toBe('function');
  });
});
