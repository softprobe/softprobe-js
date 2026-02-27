import fs from 'node:fs';
import path from 'node:path';

describe('task 2.14 - instrumentation/common http span adaptation', () => {
  const srcRoot = path.resolve(__dirname, '..');

  it('uses shared common http span adaptation helper in at least two instrumentation packages', async () => {
    const helperPath = path.join(srcRoot, 'instrumentations/common/http/span-adapter.ts');
    expect(fs.existsSync(helperPath)).toBe(true);

    const helper = await import(path.join(srcRoot, 'instrumentations/common/http/span-adapter'));
    expect(helper.buildInboundHttpIdentifier('get', '/users')).toBe('GET /users');

    const expressCaptureSource = fs.readFileSync(path.join(srcRoot, 'instrumentations/express/capture.ts'), 'utf8');
    const fastifyCaptureSource = fs.readFileSync(path.join(srcRoot, 'instrumentations/fastify/capture.ts'), 'utf8');

    expect(expressCaptureSource).toContain("from '../common/http/span-adapter'");
    expect(expressCaptureSource).toContain('buildInboundHttpIdentifier(');
    expect(fastifyCaptureSource).toContain("from '../common/http/span-adapter'");
    expect(fastifyCaptureSource).toContain('buildInboundHttpIdentifier(');
  });
});
