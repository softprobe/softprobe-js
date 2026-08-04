import { describe, expect, it } from "vitest";
import { SessionGraph } from "../src/session-graph.js";

describe("SessionGraph genealogy", () => {
  it("tracks parents and roots", () => {
    const graph = new SessionGraph();
    graph.registerParent("child", "parent");
    graph.markRoot("root");

    expect(graph.parentOf("child")).toBe("parent");
    expect(graph.isRoot("root")).toBe(true);
    expect(graph.isRoot("child")).toBe(false);

    // A later parent link reclassifies a session previously marked as root.
    graph.markRoot("late");
    expect(graph.isRoot("late")).toBe(true);
    graph.registerParent("late", "parent");
    expect(graph.isRoot("late")).toBe(false);
    expect(graph.parentOf("late")).toBe("parent");

    // markRoot never overrides a known parent or binding.
    graph.markRoot("child");
    expect(graph.isRoot("child")).toBe(false);
  });

  it("ignores self-parenting", () => {
    const graph = new SessionGraph();
    graph.registerParent("same", "same");
    expect(graph.parentOf("same")).toBeUndefined();
  });
});

describe("SessionGraph task bindings", () => {
  it("keeps metadata bindings authoritative over inferred ones", () => {
    const graph = new SessionGraph();
    graph.bind({
      childSessionID: "child",
      parentSessionID: "parent",
      taskCallID: "call-inferred",
      source: "inferred",
    });
    graph.bind({
      childSessionID: "child",
      parentSessionID: "parent",
      taskCallID: "call-metadata",
      source: "metadata",
    });
    expect(graph.bindingFor("child")?.taskCallID).toBe("call-metadata");
    expect(graph.childForTaskCall("call-metadata")).toBe("child");
    // The stale reverse link is removed.
    expect(graph.childForTaskCall("call-inferred")).toBeUndefined();

    // Inferred bindings never replace a metadata binding.
    graph.bind({
      childSessionID: "child",
      parentSessionID: "parent",
      taskCallID: "call-other",
      source: "inferred",
    });
    expect(graph.bindingFor("child")?.taskCallID).toBe("call-metadata");
  });

  it("re-binds to the new task call when a session is resumed", () => {
    const graph = new SessionGraph();
    graph.bind({
      childSessionID: "child",
      parentSessionID: "parent",
      taskCallID: "call-1",
      source: "metadata",
    });
    graph.bind({
      childSessionID: "child",
      parentSessionID: "parent",
      taskCallID: "call-2",
      source: "metadata",
    });
    expect(graph.bindingFor("child")?.taskCallID).toBe("call-2");
    expect(graph.childForTaskCall("call-1")).toBeUndefined();
    expect(graph.childForTaskCall("call-2")).toBe("child");
  });
});

describe("SessionGraph.resolveTaskCall", () => {
  it("resolves task_id resume unambiguously", () => {
    const graph = new SessionGraph();
    graph.registerTaskCall("call-1", "parent", { prompt: "a" });
    graph.registerTaskCall("call-2", "parent", {
      prompt: "b",
      task_id: "child",
    });
    expect(graph.resolveTaskCall("child", "parent", {})).toBe("call-2");
  });

  it("resolves a single candidate without hints", () => {
    const graph = new SessionGraph();
    graph.registerTaskCall("call-only", "parent", { prompt: "a" });
    expect(graph.resolveTaskCall("child", "parent", {})).toBe("call-only");
  });

  it("disambiguates by agent name, then prompt text", () => {
    const graph = new SessionGraph();
    graph.registerTaskCall("call-1", "parent", {
      prompt: "same",
      subagent_type: "verify",
    });
    graph.registerTaskCall("call-2", "parent", {
      prompt: "same",
      subagent_type: "explore",
    });
    expect(graph.resolveTaskCall("child", "parent", { agent: "verify" })).toBe(
      "call-1",
    );

    const byPrompt = new SessionGraph();
    byPrompt.registerTaskCall("call-1", "parent", { prompt: "one" });
    byPrompt.registerTaskCall("call-2", "parent", { prompt: "two" });
    expect(
      byPrompt.resolveTaskCall("child", "parent", { prompt: "two" }),
    ).toBe("call-2");
  });

  it("returns undefined on ambiguity — never guesses", () => {
    const graph = new SessionGraph();
    graph.registerTaskCall("call-1", "parent", {
      prompt: "same",
      subagent_type: "verify",
    });
    graph.registerTaskCall("call-2", "parent", {
      prompt: "same",
      subagent_type: "verify",
    });
    expect(
      graph.resolveTaskCall("child", "parent", {
        agent: "verify",
        prompt: "same",
      }),
    ).toBeUndefined();
  });

  it("scopes candidates to the parent session", () => {
    const graph = new SessionGraph();
    graph.registerTaskCall("call-elsewhere", "other-parent", { prompt: "a" });
    expect(graph.resolveTaskCall("child", "parent", {})).toBeUndefined();
  });

  it("still considers recently ended calls", () => {
    const graph = new SessionGraph();
    graph.registerTaskCall("call-1", "parent", { prompt: "a" });
    graph.endTaskCall("call-1");
    expect(graph.resolveTaskCall("child", "parent", {})).toBe("call-1");
  });

  it("merges args from repeated registrations", () => {
    const graph = new SessionGraph();
    graph.registerTaskCall("call-1", "parent", { prompt: "a" });
    graph.registerTaskCall("call-1", "parent", { subagent_type: "verify" });
    graph.registerTaskCall("call-2", "parent", { prompt: "b" });
    expect(graph.resolveTaskCall("child", "parent", { agent: "verify" })).toBe(
      "call-1",
    );
  });
});

describe("SessionGraph.evictSession", () => {
  it("drops genealogy, bindings, and task calls of the session", () => {
    const graph = new SessionGraph();
    graph.registerParent("child", "parent");
    graph.registerTaskCall("call-1", "child", { prompt: "a" });
    graph.bind({
      childSessionID: "grandchild",
      parentSessionID: "child",
      taskCallID: "call-1",
      source: "metadata",
    });

    graph.evictSession("child");
    expect(graph.parentOf("child")).toBeUndefined();
    expect(graph.bindingFor("grandchild")).toBeUndefined();
    expect(graph.childForTaskCall("call-1")).toBeUndefined();
    expect(graph.resolveTaskCall("x", "child", {})).toBeUndefined();
  });
});
