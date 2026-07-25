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
    time?: { start?: number; end?: number };
  };
  time?: { completed?: number; end?: number };
};

export type SessionErrorInfo = {
  name: string;
  message?: string;
  data?: { message?: string };
};

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
