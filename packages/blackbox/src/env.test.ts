import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { upsertEnvVar, writeEnvVar } from "./env.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "blackbox-env-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("upsertEnvVar", () => {
  it("creates new content when .env does not exist", () => {
    expect(upsertEnvVar(null, "INGESTION_KEY", "spk_123")).toEqual({
      content: "INGESTION_KEY=spk_123\n",
      action: "created",
    });
  });

  it("appends without clobbering existing vars and comments", () => {
    const existing = "# App config\nPORT=3000\nDATABASE_URL=postgres://localhost/db";
    const result = upsertEnvVar(existing, "INGESTION_KEY", "spk_abc");

    expect(result).toEqual({
      content: "# App config\nPORT=3000\nDATABASE_URL=postgres://localhost/db\nINGESTION_KEY=spk_abc\n",
      action: "updated",
    });
  });

  it("updates existing key in place and preserves export prefix", () => {
    const existing = "PORT=3000\nexport INGESTION_KEY=spk_old\nNODE_ENV=production\n";
    const updated = upsertEnvVar(existing, "INGESTION_KEY", "spk_new");

    expect(updated).toEqual({
      content: "PORT=3000\nexport INGESTION_KEY=spk_new\nNODE_ENV=production\n",
      action: "updated",
    });

    const repeat = upsertEnvVar(updated.content, "INGESTION_KEY", "spk_new");
    expect(repeat).toEqual({
      content: updated.content,
      action: "unchanged",
    });
  });

  it("preserves CRLF line endings", () => {
    const existing = "PORT=3000\r\nINGESTION_KEY=spk_old\r\n";
    const updated = upsertEnvVar(existing, "INGESTION_KEY", "spk_new");

    expect(updated.content).toBe("PORT=3000\r\nINGESTION_KEY=spk_new\r\n");
  });
});

describe("writeEnvVar", () => {
  it("writes and idempotently updates .env on disk", async () => {
    const dir = await makeTempDir();
    const envPath = path.join(dir, ".env");

    await writeFile(envPath, "FOO=bar\n", "utf8");
    const first = await writeEnvVar({
      envPath,
      key: "INGESTION_KEY",
      value: "spk_first",
    });
    expect(first.action).toBe("updated");
    await expect(readFile(envPath, "utf8")).resolves.toBe(
      "FOO=bar\nINGESTION_KEY=spk_first\n",
    );

    const second = await writeEnvVar({
      envPath,
      key: "INGESTION_KEY",
      value: "spk_first",
    });
    expect(second.action).toBe("unchanged");
  });
});
