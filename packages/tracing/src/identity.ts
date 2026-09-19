/**
 * Resolve product conversation / user identity from the builder's world.
 *
 * Priority: LangChain/LangGraph run metadata (incl. configurable) →
 * explicit Softprobe fallbacks → SOFTPROBE_* env.
 * Softprobe never invents a session id.
 */

export type IdentitySource = Record<string, unknown> | null | undefined;

const SESSION_KEYS = [
  "thread_id",
  "threadId",
  "session_id",
  "sessionId",
  "conversation_id",
  "conversationId",
  "chat_id",
  "chatId",
] as const;

const USER_KEYS = ["user_id", "userId", "user"] as const;

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function firstKey(
  sources: IdentitySource[],
  keys: readonly string[],
): string | undefined {
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    for (const key of keys) {
      const found = asNonEmptyString((source as Record<string, unknown>)[key]);
      if (found) return found;
    }
  }
  return undefined;
}

/** Flatten metadata + nested `configurable` (LangGraph) into lookup sources. */
export function identitySourcesFromMetadata(
  metadata?: Record<string, unknown> | null,
): IdentitySource[] {
  if (!metadata) return [];
  const configurable =
    metadata.configurable &&
    typeof metadata.configurable === "object" &&
    !Array.isArray(metadata.configurable)
      ? (metadata.configurable as Record<string, unknown>)
      : undefined;
  return configurable ? [configurable, metadata] : [metadata];
}

export type ResolveRunIdentityOptions = {
  metadata?: Record<string, unknown> | null;
  /** Constructor / observeOpenAI default — used only when metadata has no id. */
  fallbackSessionId?: string | null;
  fallbackUserId?: string | null;
  env?: Record<string, string | undefined>;
};

export type ResolvedRunIdentity = {
  sessionId?: string;
  userId?: string;
};

export function resolveRunIdentity(
  options: ResolveRunIdentityOptions = {},
): ResolvedRunIdentity {
  const env = options.env ?? process.env;
  const fromMeta = identitySourcesFromMetadata(options.metadata);
  return {
    sessionId:
      firstKey(fromMeta, SESSION_KEYS) ??
      asNonEmptyString(options.fallbackSessionId) ??
      asNonEmptyString(env.SOFTPROBE_SESSION_ID),
    userId:
      firstKey(fromMeta, USER_KEYS) ??
      asNonEmptyString(options.fallbackUserId) ??
      asNonEmptyString(env.SOFTPROBE_USER_ID),
  };
}
