/**
 * Task 1.1 type test: SoftprobeMode allows only CAPTURE | REPLAY | PASSTHROUGH.
 */
import type { SoftprobeMode } from '../types/schema';

describe('SoftprobeMode', () => {
  it('accepts only the three supported mode literals', () => {
    const modes: SoftprobeMode[] = ['CAPTURE', 'REPLAY', 'PASSTHROUGH'];
    expect(modes).toHaveLength(3);
    expect(modes).toContain('CAPTURE');
    expect(modes).toContain('REPLAY');
    expect(modes).toContain('PASSTHROUGH');
  });

  it('rejects unsupported mode literals at compile time', () => {
    // @ts-expect-error - unsupported mode
    const invalidMode: SoftprobeMode = 'INVALID';
    expect(invalidMode).toBe('INVALID');
  });
});
