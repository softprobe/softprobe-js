import { describe, expect, it } from "vitest";
import { normalizeToolExecuteAfterOutput } from "../src/tool-result.js";

describe("normalizeToolExecuteAfterOutput", () => {
  it("keeps registry-tool { title, output } payloads", () => {
    expect(
      normalizeToolExecuteAfterOutput({
        title: "ls",
        output: "ok",
        metadata: {},
      }),
    ).toEqual({ title: "ls", output: "ok", status: "ok" });
  });

  it("extracts text from raw MCP CallToolResult content", () => {
    expect(
      normalizeToolExecuteAfterOutput({
        content: [
          { type: "text", text: "line one" },
          { type: "text", text: "line two" },
        ],
      }),
    ).toEqual({
      title: "",
      output: "line one\n\nline two",
      status: "ok",
    });
  });

  it("includes resource text from MCP content", () => {
    expect(
      normalizeToolExecuteAfterOutput({
        content: [
          {
            type: "resource",
            resource: { text: "resource body" },
          },
        ],
      }),
    ).toEqual({
      title: "",
      output: "resource body",
      status: "ok",
    });
  });

  it("prefers normalized output when both output and content exist", () => {
    expect(
      normalizeToolExecuteAfterOutput({
        title: "doc",
        output: "truncated body",
        content: [{ type: "text", text: "raw body" }],
      }),
    ).toEqual({
      title: "doc",
      output: "truncated body",
      status: "ok",
    });
  });

  it("marks isError MCP results as error status", () => {
    expect(
      normalizeToolExecuteAfterOutput({
        isError: true,
        content: [{ type: "text", text: "boom" }],
      }),
    ).toEqual({
      title: "",
      output: "boom",
      status: "error",
    });
  });

  it("returns empty strings instead of undefined fields", () => {
    expect(normalizeToolExecuteAfterOutput({})).toEqual({
      title: "",
      output: "",
      status: "ok",
    });
  });
});
