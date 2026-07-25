import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultConfigDir,
  defaultConfigPath,
  loadSoftprobeCredentials,
  MissingSoftprobeCredentialsError,
} from "../src/config.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
});

describe("defaultConfigPath", () => {
  it("uses ~/.config/opencode when XDG_CONFIG_HOME is unset", () => {
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.OPENCODE_CONFIG_DIR;
    expect(defaultConfigDir()).toBe(join(homedir(), ".config", "opencode"));
    expect(defaultConfigPath()).toBe(
      join(homedir(), ".config", "opencode", "opencode-softprobe.json"),
    );
  });

  it("honors XDG_CONFIG_HOME", () => {
    delete process.env.OPENCODE_CONFIG_DIR;
    process.env.XDG_CONFIG_HOME = "/tmp/xdg-config";
    expect(defaultConfigPath()).toBe(
      "/tmp/xdg-config/opencode/opencode-softprobe.json",
    );
  });

  it("prefers OPENCODE_CONFIG_DIR over XDG", () => {
    process.env.XDG_CONFIG_HOME = "/tmp/xdg-config";
    process.env.OPENCODE_CONFIG_DIR = "/tmp/custom-opencode";
    expect(defaultConfigDir()).toBe("/tmp/custom-opencode");
    expect(defaultConfigPath()).toBe(
      "/tmp/custom-opencode/opencode-softprobe.json",
    );
  });

  it("candidateConfigPaths prefers spcode then opencode", async () => {
    delete process.env.OPENCODE_CONFIG_DIR;
    process.env.XDG_CONFIG_HOME = "/tmp/xdg-config";
    const { candidateConfigPaths } = await import("../src/config.js");
    expect(candidateConfigPaths()).toEqual([
      "/tmp/xdg-config/spcode/opencode-softprobe.json",
      "/tmp/xdg-config/opencode/opencode-softprobe.json",
    ]);
  });
});

describe("loadSoftprobeCredentials", () => {
  it("loads from environment variables", async () => {
    process.env.SOFTPROBE_PUBLIC_KEY = "pk-test";
    process.env.SOFTPROBE_BASE_URL = "http://127.0.0.1:8091";
    delete process.env.SOFTPROBE_OTLP_ENDPOINT;
    process.env.SOFTPROBE_ENVIRONMENT = "staging";
    process.env.SOFTPROBE_USER_ID = "dev";

    const creds = await loadSoftprobeCredentials("/nonexistent/path.json");
    expect(creds).toEqual({
      publicKey: "pk-test",
      baseUrl: "http://127.0.0.1:8091",
      otlpEndpoint: "http://127.0.0.1:8091/v1/traces",
      environment: "staging",
      userId: "dev",
      serviceName: undefined,
    });
  });

  it("loads from config file when env is incomplete", async () => {
    delete process.env.SOFTPROBE_PUBLIC_KEY;
    delete process.env.SOFTPROBE_BASE_URL;
    const dir = await mkdtemp(join(tmpdir(), "sp-oc-"));
    const path = join(dir, "opencode-softprobe.json");
    await writeFile(
      path,
      JSON.stringify({
        publicKey: "file-key",
        baseUrl: "https://softprobe.example",
        otlpEndpoint: "https://softprobe.example/custom/traces",
      }),
    );

    const creds = await loadSoftprobeCredentials(path);
    expect(creds.publicKey).toBe("file-key");
    expect(creds.otlpEndpoint).toBe("https://softprobe.example/custom/traces");
  });

  it("throws when credentials are missing", async () => {
    delete process.env.SOFTPROBE_PUBLIC_KEY;
    delete process.env.SOFTPROBE_BASE_URL;
    await expect(
      loadSoftprobeCredentials("/tmp/does-not-exist-softprobe.json"),
    ).rejects.toBeInstanceOf(MissingSoftprobeCredentialsError);
  });
});
