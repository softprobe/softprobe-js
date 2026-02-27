import fs from 'node:fs';
import path from 'node:path';

describe('task 2.8 - fetch/http outbound instrumentation migration', () => {
  const srcRoot = path.resolve(__dirname, '..');

  it('keeps fetch/http outbound implementation only under instrumentation package', async () => {
    const newReplay = path.join(srcRoot, 'instrumentations/fetch/replay.ts');
    const legacyReplay = path.join(srcRoot, 'replay/http.ts');
    expect(fs.existsSync(newReplay)).toBe(true);
    expect(fs.existsSync(legacyReplay)).toBe(false);

    const packageReplay = await import(path.join(srcRoot, 'instrumentations/fetch/replay'));

    expect(typeof packageReplay.handleHttpReplayRequest).toBe('function');
    expect(typeof packageReplay.setupHttpReplayInterceptor).toBe('function');
  });
});
