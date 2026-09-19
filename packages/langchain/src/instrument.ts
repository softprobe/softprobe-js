/**
 * Zero-setup LangChain instrumentation (env auto + `instrument()`).
 *
 * When SOFTPROBE_PUBLIC_KEY and SOFTPROBE_BASE_URL are set, Softprobe
 * registers into LangChain configure hooks so every run is traced without
 * editing `callbacks`.
 *
 * Opt out: SOFTPROBE_LANGCHAIN=0
 */
import {
  registerConfigureHook,
  setContextVariable,
} from "@langchain/core/context";
import {
  resolveSoftprobeConfigFromEnv,
  type SoftprobeEnvSource,
} from "@softprobe/tracing";
import {
  CallbackHandler,
  type CallbackHandlerParams,
} from "./CallbackHandler.js";

export const SOFTPROBE_LANGCHAIN_CONTEXT_VAR = "softprobe_langchain_handler";

let hookRegistered = false;
let activeHandler: CallbackHandler | null = null;

function envFlagDisabled(
  env: SoftprobeEnvSource = process.env,
  name = "SOFTPROBE_LANGCHAIN",
): boolean {
  const raw = env[name];
  if (raw == null) return false;
  return ["0", "false", "off", "no"].includes(raw.trim().toLowerCase());
}

export function isInstrumented(): boolean {
  return activeHandler != null;
}

export function getHandler(): CallbackHandler | null {
  return activeHandler;
}

export function instrument(
  params: CallbackHandlerParams = {},
): CallbackHandler {
  if (!hookRegistered) {
    registerConfigureHook({
      contextVar: SOFTPROBE_LANGCHAIN_CONTEXT_VAR,
      inheritable: true,
    });
    hookRegistered = true;
  }
  if (activeHandler == null || Object.keys(params).length > 0) {
    activeHandler = new CallbackHandler(params);
  }
  setContextVariable(SOFTPROBE_LANGCHAIN_CONTEXT_VAR, activeHandler);
  return activeHandler;
}

export function uninstrument(): void {
  setContextVariable(SOFTPROBE_LANGCHAIN_CONTEXT_VAR, undefined);
  activeHandler = null;
}

export function autoInstrumentFromEnv(
  params: CallbackHandlerParams = {},
  env: SoftprobeEnvSource = process.env,
): CallbackHandler | null {
  if (envFlagDisabled(env)) return null;
  if (!resolveSoftprobeConfigFromEnv(env)) return null;
  return instrument(params);
}
