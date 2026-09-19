import { describe, expect, it } from "vitest";
import { resolveRunIdentity } from "../src/identity.js";

describe("resolveRunIdentity", () => {
  it("prefers LangGraph thread_id over Softprobe fallbacks", () => {
    const id = resolveRunIdentity({
      metadata: { thread_id: "thread-app", user_id: "user-app" },
      fallbackSessionId: "sess-fallback",
      fallbackUserId: "user-fallback",
      env: {
        SOFTPROBE_SESSION_ID: "sess-env",
        SOFTPROBE_USER_ID: "user-env",
      },
    });
    expect(id).toEqual({ sessionId: "thread-app", userId: "user-app" });
  });

  it("reads nested configurable", () => {
    const id = resolveRunIdentity({
      metadata: {
        configurable: { thread_id: "cfg-thread", user_id: "cfg-user" },
      },
      env: {},
    });
    expect(id).toEqual({ sessionId: "cfg-thread", userId: "cfg-user" });
  });

  it("falls back to constructor then env", () => {
    const id = resolveRunIdentity({
      metadata: {},
      fallbackSessionId: "sess-ctor",
      env: { SOFTPROBE_USER_ID: "user-env" },
    });
    expect(id).toEqual({ sessionId: "sess-ctor", userId: "user-env" });
  });

  it("does not invent a session id", () => {
    expect(resolveRunIdentity({ metadata: {}, env: {} })).toEqual({
      sessionId: undefined,
      userId: undefined,
    });
  });
});
