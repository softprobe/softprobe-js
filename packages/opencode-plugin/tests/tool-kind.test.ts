import { describe, expect, it } from "vitest";
import { inferToolKind } from "../src/tool-kind.js";

describe("inferToolKind", () => {
  it("maps shell and file tools", () => {
    expect(inferToolKind("bash")).toBe("shell");
    expect(inferToolKind("read")).toBe("file");
    expect(inferToolKind("edit")).toBe("file");
  });

  it("maps mcp tools", () => {
    expect(inferToolKind("mcp_filesystem")).toBe("mcp");
    expect(inferToolKind("server.mcp.tool")).toBe("mcp");
  });

  it("defaults to function", () => {
    expect(inferToolKind("webfetch")).toBe("function");
  });
});
