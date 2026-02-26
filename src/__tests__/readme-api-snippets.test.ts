import fs from 'fs';
import path from 'path';

const README_PATH = path.resolve(__dirname, '..', '..', 'README.md');

describe('Task 10.1 README API snippets', () => {
  it('contains run({ mode, storage, traceId }, fn) and no legacy cassettePath API examples', () => {
    const readme = fs.readFileSync(README_PATH, 'utf8');

    expect(readme).not.toMatch(/runWithContext\s*\(/);
    expect(readme).not.toMatch(/softprobe\.run\(\s*\{[\s\S]*?\bcassettePath\s*:/);

    expect(readme).toMatch(/softprobe\.run\(\s*\{[\s\S]*?\bmode\s*:/);
    expect(readme).toMatch(/softprobe\.run\(\s*\{[\s\S]*?\bstorage\s*:/);
    expect(readme).toMatch(/softprobe\.run\(\s*\{[\s\S]*?\btraceId\s*:/);
  });
});
