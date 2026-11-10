import { describe, expect, it } from "vitest";
import { createSoftprobeObservationAttributes } from "../src/integration.js";

describe("createSoftprobeObservationAttributes", () => {
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

  it("maps operation spans to agent and populates session and user identity attributes", () => {
    const attrs = createSoftprobeObservationAttributes({
      spanType: "operation",
      operationId: "ai.generateText",
      runtimeContext: {
        sessionId: "ses_travel_01",
        userId: "usr_ada",
      },
    });
    expect(attrs["sp.observation.type"]).toBe("agent");
    expect(attrs["session.id"]).toBe("ses_travel_01");
    expect(attrs["sp.session.id"]).toBe("ses_travel_01");
    expect(attrs["gen_ai.conversation.id"]).toBe("ses_travel_01");
    expect(attrs["user.id"]).toBe("usr_ada");
    expect(attrs["sp.user.id"]).toBe("usr_ada");
  });
});
