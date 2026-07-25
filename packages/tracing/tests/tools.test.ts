import { describe, expect, it } from "vitest";
import {
  accumulateToolCallDeltas,
  finalizeToolCallDeltas,
  normalizeToolCalls,
  normalizeToolDefinitions,
  recordToolCalls,
  recordToolDefinitions,
  toolResultEventPayload,
} from "../src/tools.js";

describe("tool helpers", () => {
  it("normalizes OpenAI tool definitions and calls", () => {
    expect(
      normalizeToolDefinitions([
        {
          type: "function",
          function: {
            name: "lookup",
            description: "find",
            parameters: { type: "object" },
          },
        },
      ]),
    ).toEqual([
      {
        name: "lookup",
        description: "find",
        parameters: { type: "object" },
      },
    ]);
    expect(
      normalizeToolCalls([
        {
          id: "call_1",
          type: "function",
          function: { name: "lookup", arguments: '{"q":1}' },
        },
      ])[0],
    ).toMatchObject({
      id: "call_1",
      name: "lookup",
      arguments: '{"q":1}',
    });
  });

  it("accumulates parallel tool call deltas by index", () => {
    const state = {};
    accumulateToolCallDeltas(state, [
      { index: 0, id: "call_a", function: { name: "a", arguments: "{" } },
      { index: 1, id: "call_b", function: { name: "b", arguments: "{" } },
    ]);
    accumulateToolCallDeltas(state, [
      { index: 0, function: { arguments: '"x":1}' } },
      { index: 1, function: { arguments: '"y":2}' } },
    ]);
    const calls = finalizeToolCallDeltas(state);
    expect(calls.map((c) => c.id)).toEqual(["call_a", "call_b"]);
    expect(calls[0].arguments).toBe('{"x":1}');
    expect(calls[1].arguments).toBe('{"y":2}');
  });

  it("records attributes on observations", () => {
    const updates: unknown[] = [];
    const obs = {
      update: (opts: unknown) => updates.push(opts),
    };
    recordToolDefinitions(obs, [
      { type: "function", function: { name: "lookup" } },
    ]);
    recordToolCalls(obs, [
      { id: "c1", function: { name: "lookup", arguments: "{}" } },
    ]);
    expect(updates[0]).toMatchObject({
      attributes: { "sp.tool.available_count": 1 },
    });
    expect(updates[1]).toMatchObject({
      attributes: { "sp.tool.call_ids": ["c1"] },
    });
    expect(
      toolResultEventPayload({
        name: "lookup",
        content: "ok",
        toolCallId: "c1",
      }),
    ).toEqual({
      role: "tool",
      name: "lookup",
      content: "ok",
      tool_call_id: "c1",
    });
  });
});
