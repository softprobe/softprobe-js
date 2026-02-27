/**
 * Softprobe init must load before OpenTelemetry starts and before express loads.
 */
import '../../src/init';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

const sdk = new NodeSDK({ instrumentations: getNodeAutoInstrumentations() });
sdk.start();
