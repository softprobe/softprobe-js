import {
  InMemorySpanExporter,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { SoftprobeClient, normalizeReadableSpans } from "@softprobe/tracing";
import { describe, expect, it } from "vitest";
import { createHooksFromTracer } from "../src/index.js";
import {
  SoftprobeSessionTracer,
  type EvaluationContext,
} from "../src/softprobe.js";

function createTracer(context?: EvaluationContext) {
  const exporter = new InMemorySpanExporter();
  const client = new SoftprobeClient({
    publicKey: "test-key",
    baseUrl: "http://127.0.0.1:8091",
    spanExporter: exporter,
    useSimpleProcessor: true,
    registerProvider: false,
  });
  return {
    client,
    exporter,
    tracer: new SoftprobeSessionTracer(client, {
      evaluation: context,
    }),
  };
}

function attr(span: ReadableSpan | undefined, key: string): unknown {
  return span?.attributes[key];
}

function startTurn(tracer: SoftprobeSessionTracer, sessionID: string): void {
  tracer.traceUserMessage({
    sessionID,
    messageID: `user-${sessionID}`,
    agent: "evaluator",
    parts: [{ type: "text", text: "evaluate" }],
  });
}

describe("OpenCode evaluator integration", () => {
  it("propagates correlation metadata to evaluator root and verifier child spans", async () => {
    const context: EvaluationContext = {
      evaluationId: "eval-1",
      sopId: "sop-1",
      sopVersion: "3",
      sourceTraceId: "source-trace-1",
      evaluatorRootSessionID: "root",
      verifierAgents: ["verifier"],
    };
    const { tracer, exporter, client } = createTracer(context);
    startTurn(tracer, "root");
    tracer.traceToolStart({
      sessionID: "root",
      callID: "task-1",
      tool: "task",
      args: { subagent_type: "verifier", prompt: "check" },
    });
    tracer.traceToolPart({
      id: "part-1",
      callID: "task-1",
      sessionID: "root",
      type: "tool",
      tool: "task",
      state: {
        status: "running",
        metadata: { sessionId: "child", parentSessionId: "root" },
      },
    });
    await tracer.ensureSessionClassified("child", {
      agent: "verifier",
      promptText: "check",
    });
    startTurn(tracer, "child");
    tracer.finalizeSessionTracing();
    await client.forceFlush();

    const spans = normalizeReadableSpans(exporter.getFinishedSpans());
    const root = spans.find((span) => span.name === "opencode.turn" && span.attributes["sp.session.id"] === "root");
    const child = spans.find((span) => span.name === "opencode.turn" && span.attributes["sp.session.id"] === "child");
    for (const span of [root, child]) {
      expect(span?.attributes["sp.metadata.evaluationId"]).toBe("eval-1");
      expect(span?.attributes["sp.metadata.sopId"]).toBe("sop-1");
      expect(span?.attributes["sp.metadata.sopVersion"]).toBe("3");
      expect(span?.attributes["sp.metadata.sourceTraceId"]).toBe("source-trace-1");
    }
    expect(child?.attributes["sp.metadata.evaluatorRole"]).toBe("verifier");
    await client.shutdown();
  });

  it("captures valid, malformed, and missing scorecards without throwing", async () => {
    const { tracer, exporter, client } = createTracer({
      evaluationId: "eval-2",
      sopId: "sop-2",
      sopVersion: "1",
      sourceTraceId: "source-trace-2",
      evaluatorRootSessionID: "root",
    });
    startTurn(tracer, "root");
    tracer.traceScorecard("root", { score: 0.8, passed: true });
    tracer.traceScorecard("root", "not-json");
    tracer.traceScorecard("root");
    tracer.finalizeSessionTracing();
    await client.forceFlush();

    const scorecards = normalizeReadableSpans(exporter.getFinishedSpans()).filter(
      (span) => span.name === "opencode.evaluation.scorecard",
    );
    expect(scorecards).toHaveLength(3);
    expect(scorecards.map((span) => span.attributes["sp.metadata.scorecardStatus"])).toEqual([
      "valid",
      "malformed",
      "missing",
    ]);
    await client.shutdown();
  });

  it("rejects disallowed tools only in evaluator mode", async () => {
    const { tracer, client } = createTracer({
      evaluationId: "eval-3",
      sopId: "sop-3",
      sopVersion: "1",
      sourceTraceId: "source-trace-3",
      evaluatorRootSessionID: "root",
      allowedTools: ["read"],
    });
    const hooks = createHooksFromTracer(tracer);
    await expect(
      hooks["tool.execute.before"]?.(
        { sessionID: "root", callID: "call-1", tool: "bash" } as never,
        { args: { command: "pwd" } } as never,
      ),
    ).rejects.toThrow("not permitted");
    await client.shutdown();
  });

  it("does not mutate a subject trace when evaluator metadata is absent", async () => {
    const { tracer, exporter, client } = createTracer();
    startTurn(tracer, "subject");
    tracer.finalizeSessionTracing();
    await client.forceFlush();
    const span = normalizeReadableSpans(exporter.getFinishedSpans()).find(
      (item) => item.name === "opencode.turn",
    );
    expect(attr(exporter.getFinishedSpans()[0], "sp.metadata.evaluationId")).toBeUndefined();
    expect(span?.attributes["sp.metadata.evaluatorRole"]).toBeUndefined();
    await client.shutdown();
  });

  it("does not put evaluator correlation on an unrelated subject session", async () => {
    const { tracer, exporter, client } = createTracer({
      evaluationId: "eval-subject",
      sopId: "sop-subject",
      sopVersion: "1",
      sourceTraceId: "source-subject",
      evaluatorRootSessionID: "evaluator-root",
    });
    startTurn(tracer, "subject");
    tracer.finalizeSessionTracing();
    await client.forceFlush();
    const span = normalizeReadableSpans(exporter.getFinishedSpans()).find(
      (item) => item.name === "opencode.turn",
    );
    expect(span?.attributes["sp.metadata.evaluationId"]).toBeUndefined();
    await client.shutdown();
  });
});
