import type { JsonValue } from "@softprobe/tracing";

/** OpenCode session.next.* events omitted from some published Hooks unions. */
export type SessionNextEvent =
  | {
      id: string;
      type: "session.next.step.started";
      properties: {
        sessionID: string;
        timestamp: number;
        agent: string;
        model: {
          providerID: string;
          id: string;
          variant?: string;
        };
        snapshot?: string;
      };
    }
  | {
      id: string;
      type: "session.next.step.ended";
      properties: { sessionID: string; timestamp: number };
    }
  | {
      id: string;
      type: "session.next.step.failed";
      properties: {
        sessionID: string;
        timestamp: number;
        error: { message: string };
      };
    }
  | {
      id: string;
      type: "session.next.retried";
      properties: {
        sessionID: string;
        timestamp: number;
        attempt: number;
        error: unknown;
      };
    }
  | {
      id: string;
      type: "session.next.reasoning.ended";
      properties: {
        sessionID: string;
        timestamp: number;
        assistantMessageID: string;
        reasoningID: string;
        text: string;
      };
    }
  | {
      id: string;
      type: "session.next.compaction.ended";
      properties: {
        sessionID: string;
        timestamp: number;
        text: string;
        include?: string;
      };
    };

export type MessagePart = {
  id?: string;
  type: string;
  sessionID?: string;
  messageID?: string;
  callID?: string;
  text?: string;
  filename?: string;
  url?: string;
  name?: string;
  prompt?: string;
  agent?: string;
  tool?: string;
  state?: {
    title?: string;
    status?: string;
    error?: string;
    input?: unknown;
    output?: string;
    /**
     * Tool-state metadata. OpenCode's task tool publishes
     * `{ sessionId, parentSessionId }` here while the part is still running —
     * the authoritative link between a task call and its child session.
     */
    metadata?: Record<string, unknown>;
    time?: { start?: number; end?: number };
  };
  time?: { completed?: number; end?: number };
};

export type SessionErrorInfo = {
  name: string;
  message?: string;
  data?: { message?: string };
};

/** Session record as it appears on `session.created` / `session.updated`. */
export type SessionInfo = {
  id?: string;
  /** Set on task-tool child sessions; absent or null on roots. */
  parentID?: string | null;
};

/**
 * Session lifecycle events the plugin consumes.
 *
 * Declared locally for the same reason as {@link SessionNextEvent}: the host's
 * `Event` union resolves to `any` unless `@opencode-ai/sdk` is installed, so
 * inline casts at each call site are unchecked *and* invisible to a rename.
 * Keeping the shapes here at least makes them one searchable definition.
 */
export type SessionLifecycleEvent =
  | { type: "session.idle"; properties?: { sessionID?: string } }
  | {
      type: "session.status";
      properties?: { sessionID?: string; status?: { type?: string } };
    }
  | { type: "session.created"; properties?: { info?: SessionInfo } }
  | { type: "session.updated"; properties?: { info?: SessionInfo } }
  | { type: "session.deleted"; properties?: { info?: { id?: string } } }
  | {
      type: "session.error";
      properties?: { sessionID?: string; error?: SessionErrorInfo };
    };

/**
 * Resolves a session's parent sessionID via the OpenCode client API.
 * Returns undefined when the session is a root, unknown, or the lookup fails.
 */
export type SessionLookup = (sessionID: string) => Promise<string | undefined>;

export type UserMessageInput = {
  sessionID: string;
  messageID?: string;
  agent?: string;
  model?: { providerID: string; modelID: string };
  parts: MessagePart[];
};

export type AssistantGenerationInput = {
  sessionID: string;
  messageID: string;
  parentID: string;
  modelID: string;
  providerID: string;
  agent?: string;
  mode: string;
  created: number;
  completed: number;
  finish?: string;
  cost: number;
  tokens: {
    total?: number;
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
};

export type Jsonish = JsonValue;
