/**
 * Capture-mode initialization: hijacks NodeSDK.start to inject
 * SoftprobeTraceExporter into the span processor pipeline so all spans
 * are written to softprobe-traces.json.
 */

import shimmer from 'shimmer';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { SoftprobeTraceExporter } from './exporter';

/**
 * Hijacks NodeSDK.prototype.start so that when the SDK starts, our
 * SoftprobeTraceExporter is added to the tracer provider's span processor
 * pipeline. Call this once at app entry (e.g. from softprobe/init when in capture mode).
 */
/** Internal NodeSDK shape we need (design §5.2: reach into OTel to append our processor). */
interface NodeSDKInternal {
  _tracerProvider: { addSpanProcessor: (processor: unknown) => void };
}

export function initCapture(): void {
  shimmer.wrap(NodeSDK.prototype, 'start', function (originalStart: () => unknown) {
    return function wrappedStart(this: NodeSDKInternal) {
      const result = originalStart.apply(this, arguments as unknown as []);
      const processor = new SimpleSpanProcessor(new SoftprobeTraceExporter());
      this._tracerProvider.addSpanProcessor(processor);
      return result;
    };
  });
}
