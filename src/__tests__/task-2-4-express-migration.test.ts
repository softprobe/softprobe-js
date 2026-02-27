import fs from 'node:fs';
import path from 'node:path';

describe('task 2.4 - express instrumentation migration', () => {
  const srcRoot = path.resolve(__dirname, '..');

  it('moves express capture/replay implementation under instrumentation package', async () => {
    const newCapture = path.join(srcRoot, 'instrumentations/express/capture.ts');
    const newReplay = path.join(srcRoot, 'instrumentations/express/replay.ts');

    expect(fs.existsSync(newCapture)).toBe(true);
    expect(fs.existsSync(newReplay)).toBe(true);

    const legacyCapture = await import(path.join(srcRoot, 'capture/express'));
    const legacyReplay = await import(path.join(srcRoot, 'replay/express'));
    const packageCapture = await import(path.join(srcRoot, 'instrumentations/express/capture'));
    const packageReplay = await import(path.join(srcRoot, 'instrumentations/express/replay'));

    expect(legacyCapture.softprobeExpressMiddleware).toBe(packageCapture.softprobeExpressMiddleware);
    expect(legacyCapture.queueInboundResponse).toBe(packageCapture.queueInboundResponse);
    expect(legacyReplay.activateReplayForContext).toBe(packageReplay.activateReplayForContext);
  });
});
