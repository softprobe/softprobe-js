import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("web-record built bundles", () => {
  it("avoid inline style attribute calls that violate strict style-src 'self' CSP", () => {
    for (const file of ["../dist/index.js", "../dist/browser.js"]) {
      const content = readFileSync(resolve(import.meta.dirname, file), "utf8");
      expect(content).not.toMatch(/setAttribute\(["']style["']/);
      expect(content).toContain("cssText");
    }
  });
});
