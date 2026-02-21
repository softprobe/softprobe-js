/**
 * Task 4.3: NodeSDK Hijack.
 * Asserts that initCapture() wraps NodeSDK.prototype.start and registers
 * SoftprobeTraceExporter into the span processor pipeline.
 */

const addSpanProcessor = jest.fn();

class MockNodeSDK {
  _tracerProvider = { addSpanProcessor };

  start(): void {
    // Original start (no-op for mock)
  }
}

jest.mock('@opentelemetry/sdk-node', () => ({ NodeSDK: MockNodeSDK }));

import { initCapture } from '../capture/init';
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { SoftprobeTraceExporter } from '../capture/exporter';

describe('initCapture', () => {
  beforeEach(() => {
    addSpanProcessor.mockClear();
  });

  it('registers SoftprobeTraceExporter when NodeSDK.start() is called', () => {
    initCapture();

    const SDK = require('@opentelemetry/sdk-node').NodeSDK;
    const sdk = new SDK();
    sdk.start();

    expect(addSpanProcessor).toHaveBeenCalledTimes(1);
    const [processor] = addSpanProcessor.mock.calls[0];
    expect(processor).toBeInstanceOf(SimpleSpanProcessor);
    expect((processor as { _exporter: unknown })._exporter).toBeInstanceOf(
      SoftprobeTraceExporter
    );
  });
});
