import { describe, expect, it } from "vitest";
import { parseCliArgs } from "./args.js";
import { DEFAULT_EXPLORER_URL } from "./types.js";

describe("parseCliArgs", () => {
  it("returns help when no args or --help are passed", () => {
    expect(parseCliArgs([])).toEqual({ kind: "help" });
    expect(parseCliArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseCliArgs(["init", "-h"])).toEqual({ kind: "help" });
  });

  it("parses `init` with default options", () => {
    expect(parseCliArgs(["init"], "/tmp/my-app")).toEqual({
      kind: "init",
      options: {
        cwd: "/tmp/my-app",
        explorerUrl: DEFAULT_EXPLORER_URL,
        envFile: ".env",
        openBrowser: true,
      },
    });
  });

  it("parses flags in space-separated and equals forms", () => {
    expect(
      parseCliArgs(
        [
          "init",
          "--explorer-url",
          "https://explorer-staging.softprobe.ai/",
          "--ingestion-key=spk_ci_123",
          "--project",
          "checkout-svc",
          "--env-file=.env.local",
          "--no-open",
        ],
        "/tmp/my-app",
      ),
    ).toEqual({
      kind: "init",
      options: {
        cwd: "/tmp/my-app",
        explorerUrl: "https://explorer-staging.softprobe.ai",
        ingestionKey: "spk_ci_123",
        projectName: "checkout-svc",
        envFile: ".env.local",
        openBrowser: false,
      },
    });
  });

  it("rejects invalid explorer URLs, empty keys, and unknown commands", () => {
    expect(parseCliArgs(["init", "--explorer-url", "ftp://bad.example"])).toEqual({
      kind: "error",
      message: "Invalid --explorer-url: ftp://bad.example",
    });
    expect(parseCliArgs(["init", "--ingestion-key="])).toEqual({
      kind: "error",
      message: "--ingestion-key must not be empty",
    });
    expect(parseCliArgs(["status"])).toEqual({
      kind: "error",
      message: "Unknown command: status. Run 'blackbox --help'.",
    });
    expect(parseCliArgs(["init", "--unknown"])).toEqual({
      kind: "error",
      message: "Unknown option: --unknown",
    });
  });
});
