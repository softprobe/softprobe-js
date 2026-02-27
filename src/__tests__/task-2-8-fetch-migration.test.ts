import fs from 'node:fs';
import path from 'node:path';

describe('task 2.8 - fetch/http outbound instrumentation migration', () => {
  const srcRoot = path.resolve(__dirname, '..');

  it('moves fetch/http outbound implementation under instrumentation package', async () => {
    const newReplay = path.join(srcRoot, 'instrumentations/fetch/replay.ts');
    expect(fs.existsSync(newReplay)).toBe(true);

    const legacyReplay = await import(path.join(srcRoot, 'replay/http'));
    const packageReplay = await import(path.join(srcRoot, 'instrumentations/fetch/replay'));

    expect(legacyReplay.handleHttpReplayRequest).toBe(packageReplay.handleHttpReplayRequest);
    expect(legacyReplay.setupHttpReplayInterceptor).toBe(packageReplay.setupHttpReplayInterceptor);
  });
});
