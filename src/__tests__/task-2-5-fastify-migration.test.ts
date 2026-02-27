import fs from 'node:fs';
import path from 'node:path';

describe('task 2.5 - fastify instrumentation migration', () => {
  const srcRoot = path.resolve(__dirname, '..');

  it('moves fastify capture/replay implementation under instrumentation package', async () => {
    const newCapture = path.join(srcRoot, 'instrumentations/fastify/capture.ts');
    const newReplay = path.join(srcRoot, 'instrumentations/fastify/replay.ts');

    expect(fs.existsSync(newCapture)).toBe(true);
    expect(fs.existsSync(newReplay)).toBe(true);

    const legacyCapture = await import(path.join(srcRoot, 'capture/fastify'));
    const legacyReplay = await import(path.join(srcRoot, 'replay/fastify'));
    const packageCapture = await import(path.join(srcRoot, 'instrumentations/fastify/capture'));
    const packageReplay = await import(path.join(srcRoot, 'instrumentations/fastify/replay'));

    expect(legacyCapture.softprobeFastifyPlugin).toBe(packageCapture.softprobeFastifyPlugin);
    expect(legacyReplay.softprobeFastifyReplayPreHandler).toBe(packageReplay.softprobeFastifyReplayPreHandler);
  });
});
