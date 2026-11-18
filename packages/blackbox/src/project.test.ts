import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inferProjectName, normalizeProjectName } from "./project.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("normalizeProjectName", () => {
  it("strips npm scope prefixes", () => {
    expect(normalizeProjectName("@softprobe/demo-app")).toBe("demo-app");
  });

  it("returns null for blank input", () => {
    expect(normalizeProjectName("   ")).toBeNull();
  });
});

describe("inferProjectName", () => {
  it("reads unscoped name from package.json", async () => {
    const dir = await makeTempDir("blackbox-proj-");
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "travel-ota" }), "utf8");

    await expect(inferProjectName(dir)).resolves.toBe("travel-ota");
  });

  it("strips scope from scoped package.json name", async () => {
    const dir = await makeTempDir("blackbox-proj-");
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "@acme/billing-api" }),
      "utf8",
    );

    await expect(inferProjectName(dir)).resolves.toBe("billing-api");
  });

  it("falls back to directory name when package.json is missing or invalid", async () => {
    const dir = await makeTempDir("my-terminal-service-");
    await expect(inferProjectName(dir)).resolves.toBe(path.basename(dir));

    await writeFile(path.join(dir, "package.json"), "{not-json", "utf8");
    await expect(inferProjectName(dir)).resolves.toBe(path.basename(dir));
  });
});
