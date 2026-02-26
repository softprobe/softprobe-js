import fs from 'fs';
import path from 'path';

const REQUIRED_RELATIVE_LINKS = [
  '(./design.md)',
  '(./design-context.md)',
  '(./design-cassette.md)',
  '(./design-matcher.md)',
];

const REQUIRED_ROOT_DOC_LINKS = [
  '(design.md)',
  '(design-context.md)',
  '(design-cassette.md)',
  '(design-matcher.md)',
];

describe('Task 10.3 design link consistency', () => {
  it('design docs cross-link using design-*.md convention', () => {
    const designIndex = fs.readFileSync(path.resolve(__dirname, '..', '..', 'design.md'), 'utf8');
    const designContext = fs.readFileSync(path.resolve(__dirname, '..', '..', 'design-context.md'), 'utf8');
    const designCassette = fs.readFileSync(path.resolve(__dirname, '..', '..', 'design-cassette.md'), 'utf8');
    const designMatcher = fs.readFileSync(path.resolve(__dirname, '..', '..', 'design-matcher.md'), 'utf8');

    for (const link of REQUIRED_RELATIVE_LINKS) {
      expect(designIndex + designContext + designCassette + designMatcher).toContain(link);
    }
  });

  it('README and example README reference all required design docs', () => {
    const rootReadme = fs.readFileSync(path.resolve(__dirname, '..', '..', 'README.md'), 'utf8');
    const exampleReadme = fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'examples', 'basic-app', 'README.md'),
      'utf8'
    );

    for (const link of REQUIRED_ROOT_DOC_LINKS) {
      expect(rootReadme + exampleReadme).toContain(link);
    }
  });
});
