import { describe, expect, it } from "vitest";
import { createSoftprobeObservationAttributes } from "../src/integration.js";

describe("createSoftprobeObservationAttributes", () => {
  it("maps Vercel AI run identity into Softprobe session attributes", () => {
    const attrs = createSoftprobeObservationAttributes({
      spanType: "languageModel",
      runtimeContext: {
        chatId: "chat-existing-42",
        threadId: "thread-existing-42",
      },
    });
    expect(attrs["session.id"]).toBe("thread-existing-42");
    expect(attrs["sp.session.id"]).toBe("thread-existing-42");
    expect(attrs["sp.metadata.chatId"]).toBeUndefined();
    expect(attrs["sp.metadata.threadId"]).toBeUndefined();
  });

  it("preserves the application's existing ses_ conversation ID", () => {
    const sessionId = "ses_123e4567-e89b-12d3-a456-426614174000";
    const attrs = createSoftprobeObservationAttributes({
      spanType: "languageModel",
      runtimeContext: { sessionId },
    });
    expect(attrs["session.id"]).toBe(sessionId);
    expect(attrs["sp.session.id"]).toBe(sessionId);
    expect(attrs["gen_ai.conversation.id"]).toBe(sessionId);
    expect(attrs["sp.metadata.sessionId"]).toBeUndefined();
  });

  it("maps language model spans to generation and links prompts", () => {
    const attrs = createSoftprobeObservationAttributes({
      spanType: "languageModel",
      runtimeContext: {
        route: "weather",
        softprobePrompt: { name: "weather-chat", version: 3 },
      },
    });
    expect(attrs["sp.observation.type"]).toBe("generation");
    expect(attrs["sp.prompt.name"]).toBe("weather-chat");
    expect(attrs["sp.prompt.version"]).toBe(3);
    expect(attrs["sp.metadata.route"]).toBe("weather");
  });

  it("maps tool spans and skips fallback prompts", () => {
    const attrs = createSoftprobeObservationAttributes({
      spanType: "tool.call",
      runtimeContext: {
        softprobePrompt: {
          name: "ignored",
          version: 1,
          isFallback: true,
        },
        toolName: "lookup",
        toolCallId: "call_lookup_1",
      },
    });
    expect(attrs["sp.observation.type"]).toBe("tool");
    expect(attrs["sp.prompt.name"]).toBeUndefined();
    expect(attrs["gen_ai.tool.name"]).toBe("lookup");
    expect(attrs["gen_ai.tool.call.id"]).toBe("call_lookup_1");
    expect(attrs["sp.tool.kind"]).toBe("function");
  });
});
