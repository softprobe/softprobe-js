/**
 * Load this first so OTel starts before express/pg/redis (node -r instrumentation.ts run.ts).
 * Add Softprobe later: import "softprobe/init" as the first line here.
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

const sdk = new NodeSDK({ instrumentations: getNodeAutoInstrumentations() });
sdk.start();
