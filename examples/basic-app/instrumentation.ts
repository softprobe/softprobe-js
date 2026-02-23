/**
 * Load this first so OTel starts before express/pg/redis (node -r instrumentation.ts run.ts).
 * Softprobe init must be first so CAPTURE/REPLAY modes run before OTel wraps modules.
 * Uses repo-relative path so the example works without building the package (design §4.1).
 */
import '../../src/init';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

const sdk = new NodeSDK({ instrumentations: getNodeAutoInstrumentations() });
sdk.start();
