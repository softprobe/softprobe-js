#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  compileSessionToE2E,
  compileSessionToMaestro,
  compileSessionToMobileE2E,
  compileSessionToPlaywright,
  extractSessionBundleFromSpans,
  fetchSessionSpansFromBlackbox,
  type GeneratedFileArtifact,
  type MobileSessionPlatform,
} from "../session-compiler.js";

export type CompileSessionRunner = "playwright" | "e2e" | "e2e-mobile" | "maestro";

export interface CompileSessionCliResult {
  readonly ok: boolean;
  readonly runner: CompileSessionRunner;
  readonly sessionId: string;
  readonly platform: "web" | "ios" | "android";
  readonly bundleId?: string;
  readonly actionCount: number;
  readonly outboundAssertionCount: number;
  readonly filesWritten: readonly string[];
  readonly cacheFilesWritten: readonly string[];
}

export const COMPILE_SESSION_USAGE = [
  "Usage: softprobe-compile-session (--session-id <id> | --session-file <path>) [options]",
  "",
  "Options:",
  "  --session-id <id>                              Blackbox session ID to fetch and compile",
  "  --session-file <path>                          Local session spans JSON file to compile offline",
  "  --runner <playwright|e2e|e2e-mobile|maestro>   Target test runner (default: playwright)",
  "  --platform <ios|android>                       Mobile target platform override",
  "  --bundle-id <bundleId>                         Mobile app bundle ID / Android package name",
  "  --out <dir>                                    Output directory for generated files (default: .)",
  "  --target-url <url>                             Base URL or upstream API origin of the app under test",
  "  --endpoint <url>                               Blackbox Explorer or TheLake API endpoint",
  "  --token <token>                                Bearer token (defaults to SOFTPROBE_API_KEY / SP_TOKEN)",
  "  --workspace-id <id>                            Workspace ID header (defaults to SOFTPROBE_WORKSPACE_ID)",
  "  --project-id <id>                              e2e projectId when --runner e2e or e2e-mobile is selected",
  "  --app-identity <name>                          e2e app.identity when --runner e2e or e2e-mobile is selected",
  "  --force                                        Overwrite existing test, flow, and config files",
  "  --json                                         Emit machine-readable JSON result to stdout",
  "  -h, --help                                     Show this help text",
].join("\n");

function isCompileSessionRunner(raw: string): raw is CompileSessionRunner {
  return (
    raw === "playwright" ||
    raw === "e2e" ||
    raw === "e2e-mobile" ||
    raw === "maestro"
  );
}

function parseMobilePlatformFlag(raw: string | undefined): MobileSessionPlatform | undefined {
  if (raw === undefined) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "ios" || normalized === "android") {
    return normalized;
  }
  throw new Error(
    `--platform must be "ios" or "android", got ${JSON.stringify(raw)}`,
  );
}

function writeArtifacts(
  outDir: string,
  artifacts: readonly GeneratedFileArtifact[],
  force: boolean,
): string[] {
  if (!force) {
    const existing = artifacts
      .map((item) => path.resolve(outDir, item.relativePath))
      .filter((absPath) => existsSync(absPath));
    if (existing.length > 0) {
      throw new Error(
        `Refusing to overwrite existing generated file without --force: ${existing[0]}`,
      );
    }
  }
  const written: string[] = [];
  for (const item of artifacts) {
    const absPath = path.resolve(outDir, item.relativePath);
    mkdirSync(path.dirname(absPath), { recursive: true });
    writeFileSync(absPath, item.content, "utf8");
    written.push(absPath);
  }
  return written;
}

export async function runCompileSessionCli(
  argv: readonly string[] = process.argv.slice(2),
): Promise<CompileSessionCliResult> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      "session-id": { type: "string" },
      "session-file": { type: "string" },
      runner: { type: "string", default: "playwright" },
      platform: { type: "string" },
      "bundle-id": { type: "string" },
      out: { type: "string", default: "." },
      "target-url": { type: "string" },
      endpoint: { type: "string" },
      token: { type: "string" },
      "workspace-id": { type: "string" },
      "project-id": { type: "string" },
      "app-identity": { type: "string" },
      force: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (values.help) {
    process.stdout.write(`${COMPILE_SESSION_USAGE}\n`);
    return {
      ok: true,
      runner: "playwright",
      sessionId: "",
      platform: "web",
      actionCount: 0,
      outboundAssertionCount: 0,
      filesWritten: [],
      cacheFilesWritten: [],
    };
  }

  const runnerRaw = (values.runner ?? "playwright").trim().toLowerCase();
  if (!isCompileSessionRunner(runnerRaw)) {
    throw new Error(
      `--runner must be "playwright", "e2e", "e2e-mobile", or "maestro", got ${JSON.stringify(values.runner)}`,
    );
  }
  const runner: CompileSessionRunner = runnerRaw;
  const platformFlag = parseMobilePlatformFlag(values.platform);
  const bundleIdFlag = values["bundle-id"]?.trim() || undefined;
  const appIdentityFlag = values["app-identity"]?.trim() || undefined;
  const sessionIdFlag = values["session-id"]?.trim();
  const sessionFileFlag = values["session-file"]?.trim();

  if (!sessionIdFlag && !sessionFileFlag) {
    throw new Error("Either --session-id <id> or --session-file <jsonPath> is required");
  }

  const explicitEndpoint =
    values.endpoint?.trim() ||
    process.env.SOFTPROBE_SINK_ENDPOINT?.trim() ||
    process.env.SOFTPROBE_TRACE_ENDPOINT?.trim() ||
    process.env.SOFTPROBE_URL?.trim() ||
    process.env.SP_API_URL?.trim() ||
    process.env.THELAKE_URL?.trim() ||
    undefined;

  const endpoint = explicitEndpoint ?? "https://explorer.softprobe.ai/api/thelake";

  const token =
    values.token?.trim() ||
    process.env.SOFTPROBE_API_KEY?.trim() ||
    process.env.SOFTPROBE_TOKEN?.trim() ||
    process.env.SP_TOKEN?.trim() ||
    process.env.INGESTION_KEY?.trim() ||
    undefined;

  const workspaceId =
    values["workspace-id"]?.trim() ||
    process.env.SOFTPROBE_WORKSPACE_ID?.trim() ||
    process.env.SP_WORKSPACE_ID?.trim() ||
    undefined;

  let rawInput: unknown;
  let tracesByTraceId: Readonly<Record<string, unknown>> | undefined;

  if (sessionFileFlag) {
    const absInput = path.resolve(sessionFileFlag);
    rawInput = JSON.parse(readFileSync(absInput, "utf8"));
  } else {
    const fetched = await fetchSessionSpansFromBlackbox({
      endpoint,
      sessionId: sessionIdFlag!,
      ...(token ? { token } : {}),
      ...(workspaceId ? { workspaceId } : {}),
    });
    rawInput =
      fetched.spans.length > 0
        ? { sessionId: fetched.sessionId, spans: fetched.spans }
        : (fetched.rawSessionBody ?? { sessionId: fetched.sessionId, spans: [] });
    tracesByTraceId = fetched.tracesByTraceId;
  }

  const bundle = extractSessionBundleFromSpans(rawInput, {
    ...(sessionIdFlag ? { sessionId: sessionIdFlag } : {}),
    ...(values["target-url"] ? { baseOrigin: values["target-url"] } : {}),
    ...(tracesByTraceId ? { tracesByTraceId } : {}),
    ...(platformFlag ? { platform: platformFlag } : {}),
    ...(bundleIdFlag ? { appBundleId: bundleIdFlag } : {}),
  });

  const outDir = path.resolve(values.out ?? ".");
  const force = Boolean(values.force);
  const sinkEndpointForConfig = values.endpoint?.trim() || explicitEndpoint;

  if (runner === "playwright") {
    const compiled = compileSessionToPlaywright(bundle, {
      ...(values["target-url"] ? { targetUrl: values["target-url"] } : {}),
      ...(sinkEndpointForConfig ? { sinkEndpoint: sinkEndpointForConfig } : {}),
      ...(workspaceId ? { workspaceId } : {}),
    });
    const filesWritten = writeArtifacts(outDir, compiled.files, force);
    const result: CompileSessionCliResult = {
      ok: true,
      runner: "playwright",
      sessionId: compiled.sessionId,
      platform: bundle.platform,
      ...(bundle.appBundleId ? { bundleId: bundle.appBundleId } : {}),
      actionCount: compiled.actionCount,
      outboundAssertionCount: compiled.outboundAssertionCount,
      filesWritten,
      cacheFilesWritten: [],
    };
    if (values.json) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      process.stdout.write(
        `Compiled session ${result.sessionId} to Playwright (${result.filesWritten.length} files).\n`,
      );
    }
    return result;
  }

  if (runner === "e2e") {
    const compiled = compileSessionToE2E(bundle, {
      ...(values["project-id"] ? { projectId: values["project-id"] } : {}),
      ...(appIdentityFlag ? { appIdentity: appIdentityFlag } : {}),
      ...(values["target-url"] ? { targetUrl: values["target-url"] } : {}),
      ...(sinkEndpointForConfig ? { sinkEndpoint: sinkEndpointForConfig } : {}),
      ...(workspaceId ? { workspaceId } : {}),
    });
    const filesWritten = writeArtifacts(outDir, compiled.files, force);
    const cacheFilesWritten = writeArtifacts(outDir, compiled.cacheFiles, true);
    const result: CompileSessionCliResult = {
      ok: true,
      runner: "e2e",
      sessionId: compiled.sessionId,
      platform: bundle.platform,
      ...(bundle.appBundleId ? { bundleId: bundle.appBundleId } : {}),
      actionCount: compiled.actionCount,
      outboundAssertionCount: compiled.outboundAssertionCount,
      filesWritten,
      cacheFilesWritten,
    };
    if (values.json) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      process.stdout.write(
        `Compiled session ${result.sessionId} to e2e (${result.filesWritten.length} files, ${result.cacheFilesWritten.length} cache entries).\n`,
      );
    }
    return result;
  }

  if (runner === "e2e-mobile") {
    const compiled = compileSessionToMobileE2E(bundle, {
      ...(platformFlag ? { platform: platformFlag } : {}),
      ...(bundleIdFlag ? { bundleId: bundleIdFlag } : {}),
      ...(values["project-id"] ? { projectId: values["project-id"] } : {}),
      ...(appIdentityFlag ? { appIdentity: appIdentityFlag } : {}),
      ...(values["target-url"] ? { targetUrl: values["target-url"] } : {}),
      ...(sinkEndpointForConfig ? { sinkEndpoint: sinkEndpointForConfig } : {}),
      ...(workspaceId ? { workspaceId } : {}),
    });
    const filesWritten = writeArtifacts(outDir, compiled.files, force);
    const cacheFilesWritten = writeArtifacts(outDir, compiled.cacheFiles, true);
    const result: CompileSessionCliResult = {
      ok: true,
      runner: "e2e-mobile",
      sessionId: compiled.sessionId,
      platform: compiled.platform,
      bundleId: compiled.bundleId,
      actionCount: compiled.actionCount,
      outboundAssertionCount: compiled.outboundAssertionCount,
      filesWritten,
      cacheFilesWritten,
    };
    if (values.json) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      process.stdout.write(
        `Compiled session ${result.sessionId} to @softprobe/e2e/mobile (${result.filesWritten.length} files, ${result.cacheFilesWritten.length} cache entries).\n`,
      );
    }
    return result;
  }

  const compiled = compileSessionToMaestro(bundle, {
    ...(platformFlag ? { platform: platformFlag } : {}),
    ...(bundleIdFlag ? { bundleId: bundleIdFlag } : {}),
    ...(values["target-url"] ? { targetUrl: values["target-url"] } : {}),
  });
  const filesWritten = writeArtifacts(outDir, compiled.files, force);
  const result: CompileSessionCliResult = {
    ok: true,
    runner: "maestro",
    sessionId: compiled.sessionId,
    platform: compiled.platform,
    bundleId: compiled.bundleId,
    actionCount: compiled.actionCount,
    outboundAssertionCount: compiled.outboundAssertionCount,
    filesWritten,
    cacheFilesWritten: [],
  };
  if (values.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    process.stdout.write(
      `Compiled session ${result.sessionId} to Maestro (${result.filesWritten.length} files).\n`,
    );
  }
  return result;
}

const isMainModule = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  return (
    entry.endsWith("/compile-session.js") ||
    entry.endsWith("\\compile-session.js") ||
    entry.endsWith("/softprobe-compile-session")
  );
})();

if (isMainModule) {
  runCompileSessionCli().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${JSON.stringify({ ok: false, error: message })}\n`);
    process.exitCode = 1;
  });
}
