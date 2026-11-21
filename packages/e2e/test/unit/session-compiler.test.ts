import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildE2ECacheKeyAndHash,
  compileSessionToE2E,
  compileSessionToPlaywright,
  extractSessionBundleFromSpans,
  fetchSessionSpansFromBlackbox,
  type RecordedSemanticAction,
} from "../../src/session-compiler.js";
import { runCompileSessionCli } from "../../src/bin/compile-session.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Session compiler & multi-runtime codegen", () => {
  const quoteTraceId = "11111111111111111111111111111111";
  const payTraceId = "22222222222222222222222222222222";

  const sampleActions: RecordedSemanticAction[] = [
    {
      schemaVersion: "sp-ui-action-1",
      actionIndex: 0,
      timestampMs: 1700000001000,
      startPath: "/checkout",
      endPath: "/checkout",
      viewport: { width: 1280, height: 720 },
      verb: {
        name: "fill",
        target: {
          role: "textbox",
          name: "Passenger email",
          label: "Passenger email",
          placeholder: "traveler@example.com",
        },
        value: { kind: "literal", value: "traveler@softprobe.ai" },
        replace: true,
      },
      causedTraces: [],
      endAnchors: [
        {
          role: "textbox",
          name: "Passenger email",
          placeholder: "traveler@example.com",
          value: "traveler@softprobe.ai",
        },
      ],
      goneAnchors: [
        {
          role: "textbox",
          name: "Passenger email",
          placeholder: "traveler@example.com",
        },
      ],
      settleMs: 15,
    },
    {
      schemaVersion: "sp-ui-action-1",
      actionIndex: 1,
      timestampMs: 1700000002000,
      startPath: "/checkout",
      endPath: "/checkout",
      viewport: { width: 1280, height: 720 },
      verb: {
        name: "fill",
        target: {
          role: "textbox",
          name: "Account password",
          label: "Account password",
          inputPurpose: "password",
        },
        value: { kind: "secret", slot: "PASSWORD" },
        replace: true,
      },
      causedTraces: [],
      endAnchors: [],
      goneAnchors: [],
      settleMs: 10,
    },
    {
      schemaVersion: "sp-ui-action-1",
      actionIndex: 2,
      timestampMs: 1700000003000,
      startPath: "/checkout",
      endPath: "/checkout",
      viewport: { width: 1280, height: 720 },
      verb: {
        name: "click",
        target: {
          role: "button",
          name: "Quote fare",
        },
        point: { x: 200, y: 300 },
      },
      causedTraces: [
        {
          traceId: quoteTraceId,
          spanId: "aaaaaaaaaaaaaaaa",
          method: "POST",
          url: "http://127.0.0.1:4100/api/quote",
          status: 200,
        },
      ],
      endAnchors: [
        {
          role: "button",
          name: "Pay USD 818.64 and issue ticket",
        },
      ],
      goneAnchors: [],
      settleMs: 45,
    },
    {
      schemaVersion: "sp-ui-action-1",
      actionIndex: 3,
      timestampMs: 1700000005000,
      startPath: "/checkout",
      endPath: "/confirmation",
      viewport: { width: 1280, height: 720 },
      verb: {
        name: "click",
        target: {
          role: "button",
          name: "Pay USD 818.64 and issue ticket",
        },
        point: { x: 240, y: 360 },
      },
      causedTraces: [
        {
          traceId: payTraceId,
          spanId: "bbbbbbbbbbbbbbbb",
          method: "POST",
          url: "http://127.0.0.1:4100/api/pay",
          status: 200,
        },
      ],
      endAnchors: [
        {
          role: "status",
          name: "Ticket confirmed",
        },
      ],
      goneAnchors: [],
      settleMs: 90,
    },
  ];

  const rawSessionSpans = [
    ...sampleActions.map((act, index) => ({
      trace_id: "33333333333333333333333333333333",
      span_id: `000000000000001${index}`,
      session_id: "sess_ota_001",
      name: "softprobe.ui.action",
      start_time: new Date(act.timestampMs).toISOString(),
      attributes: {
        "sp.observation.type": "ui_action",
        "sp.ui.action.schema": "sp-ui-action-1",
        "sp.ui.action.index": act.actionIndex,
        "sp.ui.action.verb": act.verb.name,
        "sp.ui.action.summary": `${act.verb.name}-${act.actionIndex}`,
        "sp.ui.action.payload": JSON.stringify(act),
      },
    })),
    {
      trace_id: quoteTraceId,
      span_id: "cccccccccccccccc",
      parent_span_id: "aaaaaaaaaaaaaaaa",
      session_id: "sess_ota_001",
      name: "softprobe.http.body.capture",
      start_time: new Date(1700000003020).toISOString(),
      attributes: {
        "sp.observation.type": "http_body",
        "http.request.method": "POST",
        "url.full": "http://127.0.0.1:4100/api/quote",
        "http.response.body.content": JSON.stringify({
          currency: "USD",
          totalAmount: 818.64,
        }),
      },
    },
    {
      trace_id: payTraceId,
      span_id: "dddddddddddddddd",
      parent_span_id: "bbbbbbbbbbbbbbbb",
      name: "POST /api/pay",
      kind: "SERVER",
      service_name: "ota-backend",
      start_time: new Date(1700000005005).toISOString(),
      end_time: new Date(1700000005050).toISOString(),
      attributes: {
        "http.request.method": "POST",
        "url.path": "/api/pay",
        "http.response.status_code": 200,
      },
    },
    {
      trace_id: payTraceId,
      span_id: "eeeeeeeeeeeeeeee",
      parent_span_id: "dddddddddddddddd",
      name: "POST",
      kind: "CLIENT",
      service_name: "ota-backend",
      start_time: new Date(1700000005010).toISOString(),
      end_time: new Date(1700000005040).toISOString(),
      attributes: {
        "http.request.method": "POST",
        "url.full": "https://ndc-gateway.internal/v1/tickets/issue",
        "http.response.status_code": 201,
        "http.request.body.content": JSON.stringify({
          passengerEmail: "traveler@softprobe.ai",
          currency: "USD",
        }),
      },
    },
  ];

  it("extracts session bundle, detects dynamic response-derived button text, and compiles Playwright + e2e outputs", async () => {
    const bundle = extractSessionBundleFromSpans({
      session_id: "sess_ota_001",
      spans: rawSessionSpans,
    });

    expect(bundle.sessionId).toBe("sess_ota_001");
    expect(bundle.secretSlots).toEqual(["PASSWORD"]);
    expect(bundle.outboundAssertionCount).toBe(1);
    expect(bundle.steps[3]?.dynamicNamePattern).toEqual({
      literal: "Pay USD 818.64 and issue ticket",
      patternSource: "^Pay USD .* and issue ticket$",
      derivedFromTraceId: quoteTraceId,
      matchedScalars: ["818.64"],
    });

    const pw = compileSessionToPlaywright(bundle);
    const pwSpec = pw.files.find((f) => f.relativePath.endsWith(".spec.ts"))?.content ?? "";
    expect(pwSpec).toContain(`from "@softprobe/e2e/playwright"`);
    expect(pwSpec).toContain(`SP_SECRET_PASSWORD`);
    expect(pwSpec).toContain(`new RegExp("^Pay USD .* and issue ticket$")`);
    expect(pwSpec).toContain(`trace.outboundHttp`);
    expect(pwSpec).toContain(`passengerEmail`);

    const e2eSuite = compileSessionToE2E(bundle, {
      projectId: "ota-e2e",
      appIdentity: "ota-web",
      createdAt: "2026-11-21T22:00:00.000Z",
    });
    expect(e2eSuite.cacheFiles.length).toBe(2);

    const repoNodeModules = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../../node_modules",
    );
    const coreIdentityPath = path.join(
      repoNodeModules,
      "@e2e-dev/core/dist/cache/identity.js",
    );
    const coreTraceReadPath = path.join(
      repoNodeModules,
      "@e2e-dev/core/dist/cache/trace-read.js",
    );
    const coreRelocatePath = path.join(
      repoNodeModules,
      "@e2e-dev/core/dist/cache/relocate.js",
    );

    const coreIdentity = (await import(coreIdentityPath)) as {
      buildTraceCacheKey: (parts: unknown) => unknown;
      traceCacheKeyHash: (key: unknown) => string;
      traceCallSignature: (kind: string, instruction: string, params: unknown) => unknown;
      projectIdentity: (id: string) => string;
    };
    const coreTraceRead = (await import(coreTraceReadPath)) as {
      readTraceEntry: (doc: unknown) => { payload: { actions: Array<{ target?: unknown }> } } | undefined;
    };
    const coreRelocate = (await import(coreRelocatePath)) as {
      isRelocatableDescriptor: (desc: unknown) => boolean;
    };

    for (const cacheArtifact of e2eSuite.cacheFiles) {
      const parsedDoc = JSON.parse(cacheArtifact.content);
      const validated = coreTraceRead.readTraceEntry(parsedDoc);
      expect(validated).toBeDefined();
      for (const action of validated!.payload.actions) {
        if (action.target) {
          expect(coreRelocate.isRelocatableDescriptor(action.target)).toBe(true);
        }
      }
    }

    const checkKey = buildE2ECacheKeyAndHash({
      projectId: "ota-e2e",
      testId: e2eSuite.testId,
      targetId: "web",
      appIdentity: "ota-web",
      appEnvironment: "test",
      instruction: "Step 1: fill-0, then fill-1, then click-2",
      secretSlots: ["PASSWORD"],
      callIndex: 0,
    });

    const coreSignature = coreIdentity.traceCallSignature(
      "act",
      "Step 1: fill-0, then fill-1, then click-2",
      { password: { kind: "secret", name: "PASSWORD", purpose: "generic-secret" } },
    );
    const coreKey = coreIdentity.buildTraceCacheKey({
      project: coreIdentity.projectIdentity("ota-e2e"),
      testId: e2eSuite.testId,
      target: {
        targetId: "web",
        platform: "web",
        engineName: "web",
        spiVersion: 1,
        appIdentity: checkKey.keyedBy.appIdentity,
      },
      signature: coreSignature,
      callIndex: 0,
      agent: { name: "default", context: undefined },
      policyVersion: "conservative/6",
    });
    expect(checkKey.keyHash).toBe(coreIdentity.traceCacheKeyHash(coreKey));
    expect(e2eSuite.cacheFiles[0]?.relativePath).toBe(`.e2e/cache/${checkKey.keyHash}.json`);
  });

  it("fetches session spans from Explorer / TheLake endpoints and runs the CLI entrypoint", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/sessions/sess_ota_001?limit=500")) {
        return new Response("<!doctype html><html><body>SPA</body></html>", {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      if (url.includes("/api/thelake/v1/llm/sessions/sess_ota_001?limit=500")) {
        return new Response(
          JSON.stringify({
            session_id: "sess_ota_001",
            spans: rawSessionSpans.slice(0, 4),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes(`/v1/traces/${payTraceId}`) || url.includes(`/api/traces/${payTraceId}`)) {
        return new Response(
          JSON.stringify({ spans: rawSessionSpans.slice(5) }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });

    const fetched = await fetchSessionSpansFromBlackbox({
      endpoint: "http://localhost:5179",
      sessionId: "sess_ota_001",
      token: "sp_tok_123",
      workspaceId: "ws_1",
      fetchImpl: fetchMock as typeof fetch,
    });
    expect(fetched.spans).toHaveLength(4);
    expect(fetched.tracesByTraceId[payTraceId]).toBeDefined();

    const dir = mkdtempSync(path.join(os.tmpdir(), "sp-compile-cli-"));
    tempDirs.push(dir);
    const sessionFile = path.join(dir, "session.json");
    writeFileSync(
      sessionFile,
      JSON.stringify({ session_id: "sess_ota_001", spans: rawSessionSpans }),
      "utf8",
    );

    const outDir = path.join(dir, "out-e2e");
    const cliResult = await runCompileSessionCli([
      "--session-file",
      sessionFile,
      "--runner",
      "e2e",
      "--out",
      outDir,
      "--project-id",
      "cli-proj",
      "--app-identity",
      "cli-app",
    ]);
    expect(cliResult.ok).toBe(true);
    expect(cliResult.runner).toBe("e2e");
    expect(cliResult.actionCount).toBe(4);
    expect(cliResult.outboundAssertionCount).toBe(1);
    expect(cliResult.cacheFilesWritten.length).toBe(2);
    expect(readFileSync(cliResult.filesWritten[0]!, "utf8")).toContain(`describe("Recorded session replay"`);

    await expect(
      runCompileSessionCli([
        "--session-file",
        sessionFile,
        "--runner",
        "e2e",
        "--out",
        outDir,
      ]),
    ).rejects.toThrow(/without --force/);

    const overwritten = await runCompileSessionCli([
      "--session-file",
      sessionFile,
      "--runner",
      "e2e",
      "--out",
      outDir,
      "--force",
    ]);
    expect(overwritten.ok).toBe(true);
  });
});
