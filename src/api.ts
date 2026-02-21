import { AsyncLocalStorage } from 'async_hooks';
import type { SemanticMatcher } from './replay/matcher';

export interface ReplayContext {
  traceId: string;
  /** Optional matcher for replay; when set, getActiveMatcher() returns it. */
  matcher?: SemanticMatcher;
}

const replayStorage = new AsyncLocalStorage<ReplayContext | undefined>();

/**
 * Test-time API: run a function with the given replay context so that
 * concurrent tests (e.g. different workers) do not share matcher state.
 */
export function runWithContext<T>(
  context: ReplayContext,
  fn: () => T | Promise<T>
): T | Promise<T> {
  return replayStorage.run(context, fn) as T | Promise<T>;
}

/**
 * Returns the current replay context for the active async scope, or undefined if not in a replay context.
 */
export function getReplayContext(): ReplayContext | undefined {
  const store = replayStorage.getStore();
  return store === undefined ? undefined : store;
}

/**
 * Sets replay context for the current async context (e.g. in beforeEach).
 * For concurrent isolation, prefer runWithContext() so each flow has its own context.
 */
export function setReplayContext(context: ReplayContext): void {
  replayStorage.enterWith(context);
}

/**
 * Clears replay context for the current async context (e.g. in afterEach).
 */
export function clearReplayContext(): void {
  replayStorage.enterWith(undefined);
}

/**
 * Returns the SemanticMatcher for the current replay context, if any.
 * Replay interceptors (e.g. Postgres) use this to resolve live calls to recorded spans.
 */
export function getActiveMatcher(): SemanticMatcher | undefined {
  const ctx = getReplayContext();
  return ctx?.matcher;
}

export const softprobe = {
  runWithContext,
  getReplayContext,
  setReplayContext,
  clearReplayContext,
  getActiveMatcher,
};
