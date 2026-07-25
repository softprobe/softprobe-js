import { AsyncLocalStorage } from "node:async_hooks";
import type { JsonValue } from "./types.js";

export interface PropagatedAttributes {
  sessionId?: string;
  userId?: string;
  tags?: string[];
  metadata?: Record<string, JsonValue>;
  version?: string;
  release?: string;
  traceName?: string;
}

const storage = new AsyncLocalStorage<PropagatedAttributes>();

export function getPropagatedAttributes(): PropagatedAttributes {
  return { ...(storage.getStore() ?? {}) };
}

export function withAttributes<T>(
  attributes: PropagatedAttributes,
  fn: () => Promise<T> | T,
): Promise<T> | T {
  const current = getPropagatedAttributes();
  const merged: PropagatedAttributes = {
    ...current,
    ...attributes,
    metadata: {
      ...(current.metadata ?? {}),
      ...(attributes.metadata ?? {}),
    },
    tags: attributes.tags ?? current.tags,
  };
  return storage.run(merged, fn);
}
