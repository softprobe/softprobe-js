#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  compileSessionToE2E,
  compileSessionToPlaywright,
  extractSessionBundleFromSpans,
  fetchSessionSpansFromBlackbox,
  type GeneratedFileArtifact,
} from "../session-compiler.js";

export interface CompileSessionCliResult {
  readonly ok: boolean;
  readonly runner: "playwright" | "e2e";
  readonly sessionId: string;
  readonly actionCount: number;
  readonly outboundAssertionCount: number;
  readonly filesWritten: readonly string[];
  readonly cacheFilesWritten: readonly string[];
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
      out: { type: "string", default: "." },
      "target-url": { type: "string" },
      endpoint: { type: "string" },
      token: { type: "string" },
      "workspace-id": { type: "string" },
      "project-id": { type: "string" },
      "app-identity": { type: "string" },
      force: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
    strict: true,
  });

  const runnerRaw = (values.runner ?? "playwright").trim().toLowerCase();
  if (runnerRaw !== "playwright" && runnerRaw !== "e2e") {
    throw new Error(`--runner must be "playwright" or "e2e", got ${JSON.stringify(values.runner)}`);
  }
  const runner: "playwright" | "e2e" = runnerRaw;
  const sessionIdFlag = values["session-id"]?.trim();
  const sessionFileFlag = values["session-file"]?.trim();

  if (!sessionIdFlag && !sessionFileFlag) {
    throw new Error("Either --session-id <id> or --session-file <jsonPath> is required");
  }

  const endpoint =
    values.endpoint?.trim() ??
    process.env.SOFTPROBE_SINK_ENDPOINT?.trim() ??
    process.env.SOFTPROBE_TRACE_ENDPOINT?.trim() ??
    process.env.SOFTPROBE_URL?.trim() ??
    process.env.SP_API_URL?.trim() ??
    process.env.THELAKE_URL?.trim() ??
    "https://explorer.softprobe.ai/api/thelake";

  const token =
    values.token?.trim() ??
    process.env.SOFTPROBE_API_KEY?.trim() ??
    process.env.SOFTPROBE_TOKEN?.trim() ??
    process.env.SP_TOKEN?.trim() ??
    process.env.INGESTION_KEY?.trim();

  const workspaceId =
    values["workspace-id"]?.trim() ??
    process.env.SOFTPROBE_WORKSPACE_ID?.trim() ??
    process.env.SP_WORKSPACE_ID?.trim();

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
    rawInput = { sessionId: fetched.sessionId, spans: fetched.spans };
    tracesByTraceId = fetched.tracesByTraceId;
  }

  const bundle = extractSessionBundleFromSpans(rawInput, {
    ...(sessionIdFlag ? { sessionId: sessionIdFlag } : {}),
    ...(values["target-url"] ? { baseOrigin: values["target-url"] } : {}),
    ...(tracesByTraceId ? { tracesByTraceId } : {}),
  });

  const outDir = path.resolve(values.out ?? ".");

  const force = Boolean(values.force);

  if (runner === "playwright") {
    const compiled = compileSessionToPlaywright(bundle, {
      ...(values["target-url"] ? { targetUrl: values["target-url"] } : {}),
      ...(values.endpoint ? { sinkEndpoint: values.endpoint } : {}),
      ...(workspaceId ? { workspaceId } : {}),
    });
    const filesWritten = writeArtifacts(outDir, compiled.files, force);
    const result: CompileSessionCliResult = {
      ok: true,
      runner: "playwright",
      sessionId: compiled.sessionId,
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

  const compiled = compileSessionToE2E(bundle, {
    ...(values["project-id"] ? { projectId: values["project-id"] } : {}),
    ...(values["app-identity"] ? { appIdentity: values["app-identity"] } : {}),
    ...(values["target-url"] ? { targetUrl: values["target-url"] } : {}),
    ...(values.endpoint ? { sinkEndpoint: values.endpoint } : {}),
    ...(workspaceId ? { workspaceId } : {}),
  });
  const filesWritten = writeArtifacts(outDir, compiled.files, force);
  const cacheFilesWritten = writeArtifacts(outDir, compiled.cacheFiles, true);
  const result: CompileSessionCliResult = {
    ok: true,
    runner: "e2e",
    sessionId: compiled.sessionId,
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
