import fs from 'fs';
import path from 'path';

const DOC_PATHS = [
  path.resolve(__dirname, '..', '..', 'README.md'),
  path.resolve(__dirname, '..', '..', 'example-tasks.md'),
  path.resolve(__dirname, '..', '..', 'design.md'),
  path.resolve(__dirname, '..', '..', 'design-context.md'),
  path.resolve(__dirname, '..', '..', 'design-cassette.md'),
  path.resolve(__dirname, '..', '..', 'design-matcher.md'),
  path.resolve(__dirname, '..', '..', 'examples', 'basic-app', 'README.md'),
];

describe('Task 10.2 docs legacy wording', () => {
  it('contains no deprecated API names in active docs', () => {
    for (const docPath of DOC_PATHS) {
      const content = fs.readFileSync(docPath, 'utf8');
      expect(content).not.toMatch(/\brunWithContext\b/);
      expect(content).not.toMatch(/\bgetReplayContext\b/);
      expect(content).not.toMatch(/\bReplayContext\b/);
    }
  });
});
