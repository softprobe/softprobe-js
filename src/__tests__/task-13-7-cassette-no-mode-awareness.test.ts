/**
 * Task 13.7: Cassette and NdjsonCassette have no mode awareness.
 * Cassette type and implementation are pure read/write; no CAPTURE, REPLAY, or mode references.
 */

import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..');
const SCHEMA_PATH = path.join(SRC, 'types', 'schema.ts');
const NDJSON_CASSETTE_PATH = path.join(SRC, 'core', 'cassette', 'ndjson-cassette.ts');

const FORBIDDEN = ['CAPTURE', 'REPLAY', 'mode'];

function extractCassetteBlock(content: string): string {
  const lines = content.split('\n');
  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('export interface Cassette')) {
      end = i;
      for (let j = i; j >= 0; j--) {
        if (lines[j].trimStart().startsWith('/**')) {
          start = j;
          break;
        }
      }
      while (end < lines.length && !lines[end].trim().startsWith('}')) end++;
      if (end < lines.length) end++;
      break;
    }
  }
  if (start < 0 || end < 0) return '';
  return lines.slice(start, end).join('\n');
}

describe('Task 13.7: Cassette and NdjsonCassette have no mode awareness', () => {
  it('Cassette type definition has no CAPTURE, REPLAY, or mode', () => {
    const content = fs.readFileSync(SCHEMA_PATH, 'utf8');
    const block = extractCassetteBlock(content);
    expect(block).toBeTruthy();
    const violations = FORBIDDEN.filter((s) => block.includes(s));
    expect(violations).toEqual([]);
  });

  it('NdjsonCassette has no CAPTURE, REPLAY, or mode', () => {
    const content = fs.readFileSync(NDJSON_CASSETTE_PATH, 'utf8');
    const violations = FORBIDDEN.filter((s) => content.includes(s));
    expect(violations).toEqual([]);
  });
});
