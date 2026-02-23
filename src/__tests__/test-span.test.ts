/**
 * Task 3.1.1: testSpan() helper for binding tests.
 * Verifies that the mock span has setAttribute and an attributes bag that gets populated.
 */

import { testSpan } from '../bindings/test-span';

describe('testSpan()', () => {
  it('populates attributes when setAttribute is called', () => {
    const span = testSpan();
    expect(span.attributes).toEqual({});

    span.setAttribute('softprobe.protocol', 'postgres');
    span.setAttribute('softprobe.identifier', 'SELECT 1');

    expect(span.attributes).toEqual({
      'softprobe.protocol': 'postgres',
      'softprobe.identifier': 'SELECT 1',
    });
  });
});
