export {
  CallbackHandler,
  type CallbackHandlerParams,
} from "./CallbackHandler.js";
export {
  instrument,
  uninstrument,
  autoInstrumentFromEnv,
  isInstrumented,
  getHandler,
  SOFTPROBE_LANGCHAIN_CONTEXT_VAR,
} from "./instrument.js";

import { autoInstrumentFromEnv } from "./instrument.js";

/** Best-tier UX: credentials present → auto-instrument (unless SOFTPROBE_LANGCHAIN=0). */
autoInstrumentFromEnv();
