import fs from 'node:fs';
import path from 'node:path';

describe('task 2.4 - express instrumentation migration', () => {
  const srcRoot = path.resolve(__dirname, '..');

  it('keeps express implementation only under instrumentation package', async () => {
    const newCapture = path.join(srcRoot, 'instrumentations/express/capture.ts');
    const newReplay = path.join(srcRoot, 'instrumentations/express/replay.ts');
    const legacyCapture = path.join(srcRoot, 'capture/express.ts');
    const legacyReplay = path.join(srcRoot, 'replay/express.ts');

    expect(fs.existsSync(newCapture)).toBe(true);
    expect(fs.existsSync(newReplay)).toBe(true);
    expect(fs.existsSync(legacyCapture)).toBe(false);
    expect(fs.existsSync(legacyReplay)).toBe(false);

    const packageCapture = await import(path.join(srcRoot, 'instrumentations/express/capture'));
    const packageReplay = await import(path.join(srcRoot, 'instrumentations/express/replay'));

    expect(typeof packageCapture.softprobeExpressMiddleware).toBe('function');
    expect(typeof packageCapture.queueInboundResponse).toBe('function');
    expect(typeof packageReplay.activateReplayForContext).toBe('function');
  });
});
