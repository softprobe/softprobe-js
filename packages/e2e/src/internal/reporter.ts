import { mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FinishedRun, Reporter, ReporterSummary } from "e2e";
import { z } from "zod";
import { isTraceId } from "../types.js";
import type { VerifiedTraceEvent } from "./poller.js";

const STAGING_DIR_NAME = ".softprobe-staging";
const REPORT_FILE_NAME = "softprobe-traces.json";

let workerTraceSequence = 0;

const stagedTraceRecordSchema = z.object({
  seq: z.number(),
  pid: z.number(),
  runId: z.string(),
  attemptId: z.string().optional(),
  targetName: z.string().optional(),
  traceId: z.string(),
  sinkKind: z.enum(["blackbox", "arex"]),
  sinkUrl: z.string(),
  mode: z.enum(["outboundHttp", "expectNoOutboundHttp"]),
  triggeredBy: z.object({
    method: z.string(),
    url: z.string(),
    pathname: z.string(),
    headerSource: z.enum(["preserved", "minted"]),
  }),
  outboundCall: z
    .object({
      spanId: z.string(),
      method: z.string(),
      url: z.string(),
      status: z.number(),
      serviceName: z.string(),
    })
    .optional(),
  explorerTraceUrl: z.string().optional(),
  verifiedAt: z.string(),
});

export type VerifiedTraceSummaryEntry = {
  readonly traceId: string;
  readonly sinkKind: "blackbox" | "arex";
  readonly sinkUrl: string;
  readonly mode: "outboundHttp" | "expectNoOutboundHttp";
  readonly targetName?: string;
  readonly testId?: string;
  readonly title?: string;
  readonly file?: string;
  readonly attemptId?: string;
  readonly triggeredBy: {
    readonly method: string;
    readonly url: string;
    readonly pathname: string;
    readonly headerSource: "preserved" | "minted";
  };
  readonly outboundCall?: {
    readonly spanId: string;
    readonly method: string;
    readonly url: string;
    readonly status: number;
    readonly serviceName: string;
  };
  readonly explorerTraceUrl?: string;
  readonly verifiedAt: string;
};

export interface SoftprobeTracesReport {
  readonly schemaVersion: "softprobe-traces-1";
  readonly runId: string;
  readonly generatedAt: string;
  readonly traces: readonly VerifiedTraceSummaryEntry[];
}

function resolveOutputDirFromAttemptArtifacts(
  artifactsDir: string | undefined,
  projectRoot: string | undefined,
): string | undefined {
  if (artifactsDir) {
    let cursor = path.resolve(artifactsDir);
    for (let depth = 0; depth < 8; depth += 1) {
      if (path.basename(cursor) === "results") {
        return path.dirname(cursor);
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }
  if (projectRoot) {
    return path.resolve(projectRoot, ".e2e");
  }
  return undefined;
}

export function stageVerifiedTraceRecord(input: {
  readonly runId: string | undefined;
  readonly projectRoot: string | undefined;
  readonly targetName: string | undefined;
  readonly attemptId: string | undefined;
  readonly artifactsDir: string | undefined;
  readonly event: VerifiedTraceEvent;
}): void {
  if (!input.runId) return;
  const outputDir = resolveOutputDirFromAttemptArtifacts(
    input.artifactsDir,
    input.projectRoot,
  );
  if (!outputDir) return;

  workerTraceSequence += 1;
  const seq = workerTraceSequence;
  const stagingDir = path.join(outputDir, STAGING_DIR_NAME, input.runId);
  const safeAttempt = (input.attemptId ?? "attempt").replace(/[^A-Za-z0-9_.-]/g, "_");
  const fileName = `${safeAttempt}-${process.pid}-${String(seq).padStart(4, "0")}.json`;
  const tempPath = path.join(stagingDir, `.${fileName}.tmp`);
  const finalPath = path.join(stagingDir, fileName);

  const payload: z.infer<typeof stagedTraceRecordSchema> = {
    seq,
    pid: process.pid,
    runId: input.runId,
    ...(input.attemptId ? { attemptId: input.attemptId } : {}),
    ...(input.targetName ? { targetName: input.targetName } : {}),
    traceId: input.event.traceId,
    sinkKind: input.event.sinkKind,
    sinkUrl: input.event.sinkUrl,
    mode: input.event.mode,
    triggeredBy: {
      method: input.event.trigger.method,
      url: input.event.trigger.url,
      pathname: input.event.trigger.pathname,
      headerSource: input.event.trigger.headerSource,
    },
    ...(input.event.matchedCall
      ? {
          outboundCall: {
            spanId: input.event.matchedCall.spanId,
            method: input.event.matchedCall.method,
            url: input.event.matchedCall.url,
            status: input.event.matchedCall.status,
            serviceName: input.event.matchedCall.serviceName,
          },
        }
      : {}),
    ...(input.event.explorerTraceUrl
      ? { explorerTraceUrl: input.event.explorerTraceUrl }
      : {}),
    verifiedAt: new Date().toISOString(),
  };

  try {
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(tempPath, `${JSON.stringify(payload)}\n`, "utf8");
    renameSync(tempPath, finalPath);
  } catch {
    // Diagnostics staging is best-effort and must never fail a passing test assertion.
  }
}

interface AttemptLookupMeta {
  readonly testId: string;
  readonly title: string;
  readonly file: string;
  readonly targetName: string;
}

function indexReportAttempts(run: FinishedRun): Map<string, AttemptLookupMeta> {
  const byAttemptId = new Map<string, AttemptLookupMeta>();
  for (const result of run.report.run.results) {
    const title = result.titlePath.join(" > ");
    for (const attempt of result.attempts ?? []) {
      byAttemptId.set(attempt.id, {
        testId: result.testId,
        title,
        file: result.file,
        targetName: result.targetId,
      });
    }
  }
  for (const group of run.report.run.serialGroups) {
    for (const attempt of group.attempts) {
      const firstMember = attempt.members[0];
      byAttemptId.set(attempt.id, {
        testId: firstMember?.testId ?? group.id,
        title: group.titlePath.join(" > "),
        file: group.file,
        targetName: group.targetId,
      });
    }
  }
  return byAttemptId;
}

function collectStagedRecords(
  stagingDir: string,
  run: FinishedRun,
): VerifiedTraceSummaryEntry[] {
  let fileNames: string[];
  try {
    fileNames = readdirSync(stagingDir)
      .filter((name) => name.endsWith(".json") && !name.startsWith("."))
      .sort();
  } catch {
    return [];
  }

  const attemptMeta = indexReportAttempts(run);
  const parsedRecords: Array<{
    readonly raw: z.infer<typeof stagedTraceRecordSchema>;
    readonly entry: VerifiedTraceSummaryEntry;
  }> = [];

  for (const name of fileNames) {
    try {
      const content = readFileSync(path.join(stagingDir, name), "utf8");
      const json: unknown = JSON.parse(content);
      const validated = stagedTraceRecordSchema.safeParse(json);
      if (!validated.success) continue;
      const item = validated.data;
      if (!isTraceId(item.traceId)) continue;

      const meta = item.attemptId ? attemptMeta.get(item.attemptId) : undefined;
      const targetName = item.targetName ?? meta?.targetName;
      const redactedTriggerUrl = run.redact(item.triggeredBy.url);
      const redactedOutboundUrl = item.outboundCall
        ? run.redact(item.outboundCall.url)
        : undefined;

      parsedRecords.push({
        raw: item,
        entry: {
          traceId: item.traceId,
          sinkKind: item.sinkKind,
          sinkUrl: run.redact(item.sinkUrl),
          mode: item.mode,
          ...(targetName ? { targetName } : {}),
          ...(meta ? { testId: meta.testId, title: meta.title, file: meta.file } : {}),
          ...(item.attemptId ? { attemptId: item.attemptId } : {}),
          triggeredBy: {
            method: item.triggeredBy.method,
            url: redactedTriggerUrl,
            pathname: item.triggeredBy.pathname,
            headerSource: item.triggeredBy.headerSource,
          },
          ...(item.outboundCall && redactedOutboundUrl !== undefined
            ? {
                outboundCall: {
                  spanId: item.outboundCall.spanId,
                  method: item.outboundCall.method,
                  url: redactedOutboundUrl,
                  status: item.outboundCall.status,
                  serviceName: item.outboundCall.serviceName,
                },
              }
            : {}),
          ...(item.explorerTraceUrl
            ? { explorerTraceUrl: run.redact(item.explorerTraceUrl) }
            : {}),
          verifiedAt: item.verifiedAt,
        },
      });
    } catch {}
  }

  parsedRecords.sort((a, b) => {
    const timeCmp = a.raw.verifiedAt.localeCompare(b.raw.verifiedAt);
    if (timeCmp !== 0) return timeCmp;
    if (a.raw.pid !== b.raw.pid) return a.raw.pid - b.raw.pid;
    return a.raw.seq - b.raw.seq;
  });

  return parsedRecords.map((item) => item.entry);
}

export function softprobeReporter(): Reporter {
  return {
    name: "softprobe",
    async onRunFinished(run: FinishedRun): Promise<ReporterSummary | void> {
      const outputDir =
        run.reportPath !== undefined
          ? path.dirname(run.reportPath)
          : path.dirname(run.artifactsRoot);
      const runId = run.report.run.id;
      const stagingRoot = path.join(outputDir, STAGING_DIR_NAME);
      const runStagingDir = path.join(stagingRoot, runId);
      const traces = collectStagedRecords(runStagingDir, run);

      const reportDocument: SoftprobeTracesReport = {
        schemaVersion: "softprobe-traces-1",
        runId,
        generatedAt: new Date().toISOString(),
        traces,
      };

      const reportFilePath = path.join(outputDir, REPORT_FILE_NAME);
      const tempFilePath = path.join(outputDir, `.${REPORT_FILE_NAME}.${process.pid}.tmp`);
      mkdirSync(outputDir, { recursive: true });
      writeFileSync(tempFilePath, `${JSON.stringify(reportDocument, null, 2)}\n`, "utf8");
      renameSync(tempFilePath, reportFilePath);

      rmSync(runStagingDir, { recursive: true, force: true });
      try {
        rmdirSync(stagingRoot);
      } catch {
        // Ignore ENOTEMPTY and ENOENT when sibling runs share the staging root.
      }

      const relativeReportPath =
        path.relative(run.projectRoot, reportFilePath).split(path.sep).join("/") ||
        REPORT_FILE_NAME;
      const countLabel = `${traces.length} verified trace${traces.length === 1 ? "" : "s"}`;
      return [
        {
          label: "Softprobe",
          text: `${countLabel} (${relativeReportPath})`,
        },
      ];
    },
  };
}
