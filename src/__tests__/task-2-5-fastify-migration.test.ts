import fs from 'node:fs';
import path from 'node:path';

describe('task 2.5 - fastify instrumentation migration', () => {
  const srcRoot = path.resolve(__dirname, '..');

  it('keeps fastify implementation only under instrumentation package', async () => {
    const newCapture = path.join(srcRoot, 'instrumentations/fastify/capture.ts');
    const newReplay = path.join(srcRoot, 'instrumentations/fastify/replay.ts');
    const legacyCapture = path.join(srcRoot, 'capture/fastify.ts');
    const legacyReplay = path.join(srcRoot, 'replay/fastify.ts');

    expect(fs.existsSync(newCapture)).toBe(true);
    expect(fs.existsSync(newReplay)).toBe(true);
    expect(fs.existsSync(legacyCapture)).toBe(false);
    expect(fs.existsSync(legacyReplay)).toBe(false);

    const packageCapture = await import(path.join(srcRoot, 'instrumentations/fastify/capture'));
    const packageReplay = await import(path.join(srcRoot, 'instrumentations/fastify/replay'));

    expect(typeof packageCapture.softprobeFastifyPlugin).toBe('function');
    expect(typeof packageReplay.softprobeFastifyReplayPreHandler).toBe('function');
  });
});
