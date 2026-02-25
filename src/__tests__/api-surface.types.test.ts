import { softprobe } from '../api';

describe('softprobe API surface', () => {
  it('does not expose legacy runWithContext', () => {
    // @ts-expect-error runWithContext has been removed from public API
    softprobe.runWithContext;
  });
});
