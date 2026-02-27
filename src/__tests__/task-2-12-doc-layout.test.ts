import fs from 'node:fs';
import path from 'node:path';

describe('task 2.12 - docs layout sync', () => {
  it('documents core and instrumentation package-oriented structure', () => {
    const rootReadme = fs.readFileSync(path.resolve(__dirname, '..', '..', 'README.md'), 'utf8');

    expect(rootReadme).toContain('src/core');
    expect(rootReadme).toContain('src/instrumentations/<package>');
    expect(rootReadme).toContain('src/instrumentations/common');
  });
});
