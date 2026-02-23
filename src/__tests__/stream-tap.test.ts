/**
 * Task 10.1: HTTP capture stream tap utilities.
 * - 10.1.1: tapReadableStream with maxPayloadSize cap (truncates, sets truncated=true).
 * - 10.1.2: Tap does not consume original stream (consumer reads full stream).
 */

import { Readable } from 'stream';

import { tapReadableStream } from '../capture/stream-tap';

describe('tapReadableStream', () => {
  /**
   * Task 10.1.1: maxPayloadSize cap truncates and sets truncated=true.
   */
  it('caps collected payload at maxPayloadSize and sets truncated=true when exceeded', async () => {
    const content = Buffer.from('a'.repeat(100));
    const source = Readable.from(content);
    const maxPayloadSize = 10;

    const { readable, getCaptured } = tapReadableStream(source, { maxPayloadSize });

    // Drain the stream so it completes
    const chunks: Buffer[] = [];
    for await (const chunk of readable) chunks.push(chunk);
    const consumed = Buffer.concat(chunks);

    const captured = await getCaptured();

    expect(consumed.length).toBe(100);
    expect(captured.body.length).toBe(10);
    expect(captured.body.equals(Buffer.from('a'.repeat(10)))).toBe(true);
    expect(captured.truncated).toBe(true);
  });

  /**
   * Task 10.1.2: Tap does not consume original stream; original consumer still reads full stream.
   */
  it('does not consume original stream — consumer reads full content', async () => {
    const content = Buffer.from('hello world');
    const source = Readable.from(content);
    const maxPayloadSize = 1024;

    const { readable, getCaptured } = tapReadableStream(source, { maxPayloadSize });

    const chunks: Buffer[] = [];
    for await (const chunk of readable) chunks.push(chunk);
    const consumed = Buffer.concat(chunks);

    const captured = await getCaptured();

    expect(consumed.toString()).toBe('hello world');
    expect(captured.body.toString()).toBe('hello world');
    expect(captured.truncated).toBe(false);
  });
});
