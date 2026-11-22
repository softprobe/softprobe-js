import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  buildE2ECacheKeyAndHash,
  compileSessionToE2E,
  compileSessionToPlaywright,
  extractSessionBundleFromSpans,
  fetchSessionSpansFromBlackbox,
  type RecordedSemanticAction,
} from "../../src/session-compiler.js";
import {
  COMPILE_SESSION_USAGE,
  runCompileSessionCli,
} from "../../src/bin/compile-session.js";

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
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
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
      fetchImpl: fetchMock,
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

    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const helpResult = await runCompileSessionCli(["--help"]);
      expect(helpResult.ok).toBe(true);
      expect(helpResult.filesWritten).toEqual([]);
      expect(writeSpy).toHaveBeenCalledWith(`${COMPILE_SESSION_USAGE}\n`);
      expect(COMPILE_SESSION_USAGE).toContain(".e2e/cache/<sha256>.json");
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("compiles dynamic URL templates, prior-scalar paths, and multi-trace actions into RegExp matchers and Promise.all waits", () => {
    const createUserTraceId = "44444444444444444444444444444444";
    const updateUserTraceId = "55555555555555555555555555555555";
    const auditFirstTraceId = "66666666666666666666666666666666";
    const auditSecondTraceId = "77777777777777777777777777777777";
    const orderConfirmTraceId = "88888888888888888888888888888888";

    const actions: RecordedSemanticAction[] = [
      {
        schemaVersion: "sp-ui-action-1",
        actionIndex: 0,
        timestampMs: 1700000010000,
        startPath: "/users",
        endPath: "/users",
        viewport: { width: 1280, height: 720 },
        verb: {
          name: "click",
          target: { role: "button", name: "Create user" },
          point: { x: 100, y: 100 },
        },
        causedTraces: [
          {
            traceId: createUserTraceId,
            method: "POST",
            url: "http://127.0.0.1:4100/api/users",
            status: 201,
          },
        ],
        endAnchors: [],
        goneAnchors: [],
        settleMs: 25,
      },
      {
        schemaVersion: "sp-ui-action-1",
        actionIndex: 1,
        timestampMs: 1700000012000,
        startPath: "/users",
        endPath: "/users",
        viewport: { width: 1280, height: 720 },
        verb: {
          name: "click",
          target: { role: "button", name: "Sync and confirm" },
          point: { x: 120, y: 140 },
        },
        causedTraces: [
          {
            traceId: updateUserTraceId,
            method: "PUT",
            url: "http://127.0.0.1:4100/api/users/42",
            urlTemplate: "http://127.0.0.1:4100/api/users/{id}",
            status: 200,
          },
          {
            traceId: auditFirstTraceId,
            method: "POST",
            url: "http://127.0.0.1:4100/api/audit",
            status: 202,
          },
          {
            traceId: auditSecondTraceId,
            method: "POST",
            url: "http://127.0.0.1:4100/api/audit",
            status: 202,
          },
          {
            traceId: orderConfirmTraceId,
            method: "POST",
            url: "http://127.0.0.1:4100/api/quotes/Q-98765/confirm",
            status: 200,
          },
        ],
        endAnchors: [],
        goneAnchors: [],
        settleMs: 60,
      },
    ];

    const spans = [
      ...actions.map((act, idx) => ({
        trace_id: "99999999999999999999999999999999",
        span_id: `000000000000002${idx}`,
        session_id: "sess_dyn_001",
        name: "softprobe.ui.action",
        startTimeUnixNano: 1700000010000000000 + idx * 2000000000 + 0.75,
        attributes: {
          "sp.observation.type": "ui_action",
          "sp.ui.action.schema": "sp-ui-action-1",
          "sp.ui.action.index": act.actionIndex,
          "sp.ui.action.verb": act.verb.name,
          "sp.ui.action.payload": JSON.stringify(act),
        },
      })),
      {
        trace_id: createUserTraceId,
        span_id: "0000000000000031",
        session_id: "sess_dyn_001",
        name: "softprobe.http.body.capture",
        startTimeUnixNano: "1.7000000105e+18",
        attributes: {
          "sp.observation.type": "http_body",
          "http.request.method": "POST",
          "url.full": "http://127.0.0.1:4100/api/users",
          "http.response.body.content": JSON.stringify({
            userId: 42,
            quoteCode: "Q-98765",
          }),
        },
      },
      {
        trace_id: updateUserTraceId,
        span_id: "0000000000000032",
        name: "PUT /api/users/:id",
        kind: "SERVER",
        service_name: "users-api",
        startTimeUnixNano: 1700000012005000000.5,
        attributes: {
          "http.request.method": "PUT",
          "http.route": "/api/users/:id",
          "http.response.status_code": 200,
        },
      },
      {
        trace_id: updateUserTraceId,
        span_id: "0000000000000033",
        parent_span_id: "0000000000000032",
        name: "POST",
        kind: "CLIENT",
        service_name: "users-api",
        startTimeUnixNano: 1700000012010000000.25,
        attributes: {
          "http.request.method": "POST",
          "url.full": "https://crm.internal/v1/sync",
          "http.response.status_code": 200,
        },
      },
      {
        trace_id: orderConfirmTraceId,
        span_id: "0000000000000034",
        name: "POST /api/quotes/Q-98765/confirm",
        kind: "SERVER",
        service_name: "orders-api",
        startTimeUnixNano: "1700000012020000000",
        attributes: {
          "http.request.method": "POST",
          "url.path": "/api/quotes/Q-98765/confirm",
          "http.response.status_code": 200,
        },
      },
      {
        trace_id: orderConfirmTraceId,
        span_id: "0000000000000035",
        parent_span_id: "0000000000000034",
        name: "POST",
        kind: "CLIENT",
        service_name: "orders-api",
        startTimeUnixNano: "1700000012025000000",
        attributes: {
          "http.request.method": "POST",
          "url.full": "https://ledger.internal/v1/charge",
          "http.response.status_code": 200,
        },
      },
    ];

    const bundle = extractSessionBundleFromSpans({
      session_id: "sess_dyn_001",
      spans,
    });

    const step1Traces = bundle.steps[1]?.backendTraces ?? [];
    expect(step1Traces).toHaveLength(4);
    expect(step1Traces[0]?.triggerPathMatcher).toEqual({
      kind: "regex",
      patternSource: "^\\/api\\/users\\/[^/]+\\/?$",
    });
    expect(new RegExp(step1Traces[0]!.triggerPathMatcher.kind === "regex" ? step1Traces[0]!.triggerPathMatcher.patternSource : "").test("/api/users/999")).toBe(true);
    expect(step1Traces[3]?.triggerPathMatcher).toEqual({
      kind: "regex",
      patternSource: "^\\/api\\/quotes\\/[^/]+\\/confirm\\/?$",
    });
    expect(new RegExp(step1Traces[3]!.triggerPathMatcher.kind === "regex" ? step1Traces[3]!.triggerPathMatcher.patternSource : "").test("/api/quotes/Q-11111/confirm")).toBe(true);

    const pwSpec =
      compileSessionToPlaywright(bundle).files.find((f) => f.relativePath.endsWith(".spec.ts"))
        ?.content ?? "";
    expect(pwSpec).toContain("const responsePromises_1 = [");
    expect(pwSpec).toContain("await Promise.all(responsePromises_1);");
    expect(pwSpec).toContain("++seen === 2");
    expect(pwSpec).toContain(
      `triggeredBy: { method: "PUT", path: new RegExp("^\\\\/api\\\\/users\\\\/[^/]+\\\\/?$") }`,
    );
    expect(pwSpec).toContain(
      `triggeredBy: { method: "POST", path: new RegExp("^\\\\/api\\\\/quotes\\\\/[^/]+\\\\/confirm\\\\/?$") }`,
    );

    const e2eSpec =
      compileSessionToE2E(bundle).files.find((f) => f.relativePath.endsWith(".e2e.ts"))?.content ??
      "";
    expect(e2eSpec).toContain(
      `triggeredBy: { method: "PUT", path: new RegExp("^\\\\/api\\\\/users\\\\/[^/]+\\\\/?$") }`,
    );
  });

  it("disambiguates colliding secret slot identifiers, pairs dialog steps, and folds cancelled group anchors", () => {
    const actions: RecordedSemanticAction[] = [
      {
        schemaVersion: "sp-ui-action-1",
        actionIndex: 0,
        timestampMs: 1700000020000,
        startPath: "/settings",
        endPath: "/settings",
        viewport: { width: 1280, height: 720 },
        verb: {
          name: "fill",
          target: { role: "textbox", name: "Primary key", label: "Primary key" },
          value: { kind: "secret", slot: "api-key" },
          replace: true,
        },
        causedTraces: [],
        endAnchors: [{ role: "status", name: "Draft unsaved" }],
        goneAnchors: [],
        settleMs: 10,
      },
      {
        schemaVersion: "sp-ui-action-1",
        actionIndex: 1,
        timestampMs: 1700000021000,
        startPath: "/settings",
        endPath: "/settings",
        viewport: { width: 1280, height: 720 },
        verb: {
          name: "fill",
          target: { role: "textbox", name: "Secondary key", label: "Secondary key" },
          value: { kind: "secret", slot: "api.key" },
          replace: true,
        },
        causedTraces: [],
        endAnchors: [],
        goneAnchors: [{ role: "status", name: "Draft unsaved" }],
        settleMs: 10,
      },
      {
        schemaVersion: "sp-ui-action-1",
        actionIndex: 2,
        timestampMs: 1700000022000,
        startPath: "/settings",
        endPath: "/settings",
        viewport: { width: 1280, height: 720 },
        verb: {
          name: "click",
          target: { role: "button", name: "Rotate keys" },
          point: { x: 150, y: 220 },
        },
        causedTraces: [],
        endAnchors: [{ role: "status", name: "Keys rotated" }],
        goneAnchors: [{ role: "button", name: "Legacy token" }],
        settleMs: 20,
      },
      {
        schemaVersion: "sp-ui-action-1",
        actionIndex: 3,
        timestampMs: 1700000022010,
        startPath: "/settings",
        endPath: "/settings",
        viewport: { width: 1280, height: 720 },
        verb: {
          name: "dialog",
          dialogType: "prompt",
          accepted: true,
          promptText: { kind: "secret", slot: "api.key" },
        },
        causedTraces: [],
        endAnchors: [],
        goneAnchors: [],
        settleMs: 5,
      },
      {
        schemaVersion: "sp-ui-action-1",
        actionIndex: 4,
        timestampMs: 1700000023000,
        startPath: "/settings",
        endPath: "/settings",
        viewport: { width: 1280, height: 720 },
        verb: {
          name: "click",
          target: { role: "button", name: "Cancel reset" },
          point: { x: 180, y: 220 },
        },
        causedTraces: [],
        endAnchors: [],
        goneAnchors: [],
        settleMs: 10,
      },
      {
        schemaVersion: "sp-ui-action-1",
        actionIndex: 5,
        timestampMs: 1700000023005,
        startPath: "/settings",
        endPath: "/settings",
        viewport: { width: 1280, height: 720 },
        verb: {
          name: "dialog",
          dialogType: "confirm",
          accepted: false,
        },
        causedTraces: [],
        endAnchors: [],
        goneAnchors: [],
        settleMs: 5,
      },
    ];

    const bundle = extractSessionBundleFromSpans({
      session_id: "sess_secrets_dialog",
      spans: actions.map((act, idx) => ({
        trace_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        span_id: `000000000000004${idx}`,
        session_id: "sess_secrets_dialog",
        name: "softprobe.ui.action",
        start_time: new Date(act.timestampMs).toISOString(),
        attributes: {
          "sp.observation.type": "ui_action",
          "sp.ui.action.schema": "sp-ui-action-1",
          "sp.ui.action.index": act.actionIndex,
          "sp.ui.action.verb": act.verb.name,
          "sp.ui.action.payload": JSON.stringify(act),
        },
      })),
    });

    const pwSpec =
      compileSessionToPlaywright(bundle).files.find((f) => f.relativePath.endsWith(".spec.ts"))
        ?.content ?? "";
    expect(pwSpec).toContain(`const secret_api_key = requireSecret("SP_SECRET_api-key", "E2E_SECRET_api-key");`);
    expect(pwSpec).toContain(`const secret_api_key_2 = requireSecret("SP_SECRET_api.key", "E2E_SECRET_api.key");`);
    expect(pwSpec).toContain(`.fill(secret_api_key);`);
    expect(pwSpec).toContain(`.fill(secret_api_key_2);`);
    expect(pwSpec).toContain(`page.once("dialog", (dialog) => dialog.accept(secret_api_key_2));`);
    expect(pwSpec).toContain(`page.once("dialog", (dialog) => dialog.dismiss());`);

    const e2eSuite = compileSessionToE2E(bundle, {
      projectId: "sec-proj",
      appIdentity: "sec-app",
    });
    const e2eSpec =
      e2eSuite.files.find((f) => f.relativePath.endsWith(".e2e.ts"))?.content ?? "";
    expect(e2eSpec).toContain(`"api_key": secrets.get("api-key")`);
    expect(e2eSpec).toContain(`"api_key_2": secrets.get("api.key")`);
    expect(e2eSpec).toContain(`browser.onDialog((dialog) => dialog.accept(secrets.get("api.key")));`);
    expect(e2eSpec).toContain(`browser.onDialog((dialog) => dialog.dismiss());`);

    const firstCacheDoc = z
      .object({
        payload: z.object({
          endAnchors: z.array(z.object({ name: z.string().optional() })).optional(),
          goneAnchors: z.array(z.object({ name: z.string().optional() })).optional(),
        }),
      })
      .parse(JSON.parse(e2eSuite.cacheFiles[0]!.content));
    expect(firstCacheDoc.payload.endAnchors?.map((a) => a.name)).toEqual(["Keys rotated"]);
    expect(firstCacheDoc.payload.goneAnchors?.map((a) => a.name)).toEqual(["Legacy token"]);
  });

  it("caches preferred trace endpoint pattern and bounds concurrency in fetchSessionSpansFromBlackbox", async () => {
    const traceIds = Array.from({ length: 6 }, (_, idx) =>
      `${idx + 1}`.repeat(32),
    );
    const sessionSpans = traceIds.map((tid, idx) => ({
      trace_id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      span_id: `000000000000005${idx}`,
      session_id: "sess_perf_001",
      name: "softprobe.ui.action",
      start_time: new Date(1700000030000 + idx * 100).toISOString(),
      attributes: {
        "sp.observation.type": "ui_action",
        "sp.ui.action.schema": "sp-ui-action-1",
        "sp.ui.action.index": idx,
        "sp.ui.action.verb": "click",
        "sp.ui.action.payload": JSON.stringify({
          schemaVersion: "sp-ui-action-1",
          actionIndex: idx,
          timestampMs: 1700000030000 + idx * 100,
          startPath: "/",
          endPath: "/",
          viewport: { width: 1280, height: 720 },
          verb: { name: "click", target: { role: "button", name: `Btn ${idx}` }, point: { x: 10, y: 10 } },
          causedTraces: [{ traceId: tid, method: "POST", url: "http://127.0.0.1:4100/api/ping", status: 200 }],
          endAnchors: [],
          goneAnchors: [],
          settleMs: 10,
        } satisfies RecordedSemanticAction),
      },
    }));

    let inFlight = 0;
    let maxInFlight = 0;
    const requestedTraceUrls: string[] = [];

    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes("/sessions/sess_perf_001")) {
        return new Response(
          JSON.stringify({ session_id: "sess_perf_001", spans: sessionSpans }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      requestedTraceUrls.push(url);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;

      const match = /\/api\/traces\/([0-9a-f]{32})$/.exec(url);
      if (match) {
        return new Response(JSON.stringify({ traceId: match[1], spans: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });

    const fetched = await fetchSessionSpansFromBlackbox({
      endpoint: "http://localhost:5179",
      sessionId: "sess_perf_001",
      fetchImpl: fetchMock,
    });

    expect(Object.keys(fetched.tracesByTraceId)).toHaveLength(6);
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(requestedTraceUrls.length).toBeLessThanOrEqual(10);
  });

  it("omits role twin .nth() on unique cssSelector locators and infers slow browser HTTP causedTraces", () => {
    const slowTraceId = "70d9ef7fa2ac8f0fd6349af6c988f1b4";
    const spans = [
      {
        trace_id: "09d54db4587744140e9e569e0d2ebc2c",
        span_id: "36cebb08df71847d",
        session_id: "sess_slow_ota",
        name: "softprobe.ui.action",
        service_name: "travel-ota-web",
        start_time: "2026-11-22T06:22:47.375Z",
        attributes: {
          "sp.observation.type": "ui_action",
          "sp.ui.action.schema": "sp-ui-action-1",
          "sp.ui.action.index": 0,
          "sp.ui.action.verb": "select",
          "sp.ui.action.payload": JSON.stringify({
            schemaVersion: "sp-ui-action-1",
            actionIndex: 0,
            timestampMs: 1795328567375,
            startPath: "/index.html",
            endPath: "/index.html",
            viewport: { width: 1280, height: 720 },
            verb: {
              name: "select",
              target: { role: "combobox", cssSelector: "#fromCity", position: { index: 0, of: 2 } },
              value: { kind: "literal", value: "LHR" },
            },
            causedTraces: [],
            endAnchors: [],
            goneAnchors: [],
            settleMs: 10,
          } satisfies RecordedSemanticAction),
        },
      },
      {
        trace_id: "d41284d8f7df68b50bd3351336350853",
        span_id: "5dfa2e52dff0ee5a",
        session_id: "sess_slow_ota",
        name: "softprobe.ui.action",
        service_name: "travel-ota-web",
        start_time: "2026-11-22T06:22:47.388Z",
        attributes: {
          "sp.observation.type": "ui_action",
          "sp.ui.action.schema": "sp-ui-action-1",
          "sp.ui.action.index": 1,
          "sp.ui.action.verb": "select",
          "sp.ui.action.payload": JSON.stringify({
            schemaVersion: "sp-ui-action-1",
            actionIndex: 1,
            timestampMs: 1795328567388,
            startPath: "/index.html",
            endPath: "/index.html",
            viewport: { width: 1280, height: 720 },
            verb: {
              name: "select",
              target: { role: "combobox", cssSelector: "#toCity", position: { index: 1, of: 2 } },
              value: { kind: "literal", value: "CDG" },
            },
            causedTraces: [],
            endAnchors: [],
            goneAnchors: [],
            settleMs: 10,
          } satisfies RecordedSemanticAction),
        },
      },
      {
        trace_id: "c47c0ac3251daaf985c67de2eba0c6a5",
        span_id: "c7ace69b1f105a67",
        session_id: "sess_slow_ota",
        name: "softprobe.ui.action",
        service_name: "travel-ota-web",
        start_time: "2026-11-22T06:22:47.535Z",
        attributes: {
          "sp.observation.type": "ui_action",
          "sp.ui.action.schema": "sp-ui-action-1",
          "sp.ui.action.index": 2,
          "sp.ui.action.verb": "click",
          "sp.ui.action.payload": JSON.stringify({
            schemaVersion: "sp-ui-action-1",
            actionIndex: 2,
            timestampMs: 1795328567535,
            startPath: "/index.html",
            endPath: "/index.html",
            viewport: { width: 1280, height: 720 },
            verb: {
              name: "click",
              target: { role: "button", name: "Search" },
              point: { x: 639, y: 495 },
            },
            causedTraces: [],
            endAnchors: [],
            goneAnchors: [],
            settleMs: 1501,
          } satisfies RecordedSemanticAction),
        },
      },
      {
        trace_id: slowTraceId,
        span_id: "212f017d20f67626",
        session_id: "sess_slow_ota",
        name: "POST",
        service_name: "travel-ota-web",
        start_time: "2026-11-22T06:22:47.537Z",
        attributes: {
          "http.request.method": "POST",
          "http.response.status_code": 200,
          "url.full": "http://127.0.0.1:45475/api/flights/search",
        },
      },
      {
        trace_id: slowTraceId,
        span_id: "c4e0e2d217f45419",
        session_id: "sess_slow_ota",
        name: "POST /api/flights/search",
        span_kind: "SERVER",
        service_name: "travel-ota",
        start_time: "2026-11-22T06:22:47.543Z",
        attributes: {
          "http.request.method": "POST",
          "http.route": "/api/flights/search",
          "http.response.status_code": 200,
        },
      },
      {
        trace_id: slowTraceId,
        span_id: "dc0f3f49f1e3f44f",
        parent_span_id: "c4e0e2d217f45419",
        session_id: "sess_slow_ota",
        name: "POST /*/*/airshopping",
        span_kind: "CLIENT",
        service_name: "travel-ota",
        start_time: "2026-11-22T06:22:48.293Z",
        attributes: {
          "http.request.method": "POST",
          "http.response.status_code": 200,
          "url.full": "https://spair.softprobe.ai/ndc/v21.3/airshopping",
        },
      },
    ];

    const bundle = extractSessionBundleFromSpans({ session_id: "sess_slow_ota", spans });
    expect(bundle.outboundAssertionCount).toBe(1);
    const pwSpec =
      compileSessionToPlaywright(bundle).files.find((f) => f.relativePath.endsWith(".spec.ts"))
        ?.content ?? "";
    expect(pwSpec).toContain(`page.locator("#fromCity").selectOption("LHR");`);
    expect(pwSpec).toContain(`page.locator("#toCity").selectOption("CDG");`);
    expect(pwSpec).not.toContain(`page.locator("#toCity").nth(1)`);
    expect(pwSpec).toContain(`new RegExp("^[\\\\s\\\\p{Co}]*Search[\\\\s\\\\p{Co}]*$", "u")`);
    expect(pwSpec).toContain(`triggeredBy: { method: "POST", path: "/api/flights/search" }`);
    expect(pwSpec).toContain(`/ndc/v21\\\\.3/airshopping$`);

    const searchNameRegex = new RegExp("^[\\s\\p{Co}]*Search[\\s\\p{Co}]*$", "u");
    expect(searchNameRegex.test("\uf002 Search")).toBe(true);
    expect(searchNameRegex.test("Search")).toBe(true);
    expect(searchNameRegex.test("Search Flights")).toBe(false);
  });

  it("folds MPA cross-page load navigations into the triggering action endPath and maps image roles to img", () => {
    const bundle = extractSessionBundleFromSpans({
      session_id: "sess_mpa_fold",
      spans: [
        {
          trace_id: "11111111111111111111111111111111",
          span_id: "0000000000000001",
          session_id: "sess_mpa_fold",
          name: "softprobe.ui.action",
          start_time: "2026-11-22T07:00:45.742Z",
          attributes: {
            "sp.observation.type": "ui_action",
            "sp.ui.action.schema": "sp-ui-action-1",
            "sp.ui.action.index": 0,
            "sp.ui.action.verb": "click",
            "sp.ui.action.summary": 'tap button "Search"',
            "sp.ui.action.payload": JSON.stringify({
              schemaVersion: "sp-ui-action-1",
              actionIndex: 0,
              timestampMs: 1795330845742,
              startPath: "/index.html",
              endPath: "/index.html",
              viewport: { width: 1280, height: 720 },
              verb: {
                name: "click",
                target: { role: "image", name: 'Brand "Logo"' },
                point: { x: 100, y: 100 },
              },
              causedTraces: [],
              endAnchors: [],
              goneAnchors: [],
              settleMs: 3214,
            } satisfies RecordedSemanticAction),
          },
        },
        {
          trace_id: "22222222222222222222222222222222",
          span_id: "0000000000000002",
          session_id: "sess_mpa_fold",
          name: "softprobe.ui.action",
          start_time: "2026-11-22T07:00:49.100Z",
          attributes: {
            "sp.observation.type": "ui_action",
            "sp.ui.action.schema": "sp-ui-action-1",
            "sp.ui.action.index": 1,
            "sp.ui.action.verb": "navigate",
            "sp.ui.action.summary": "navigate to /list.html",
            "sp.ui.action.payload": JSON.stringify({
              schemaVersion: "sp-ui-action-1",
              actionIndex: 1,
              timestampMs: 1795330849100,
              startPath: "/index.html",
              endPath: "/list.html",
              viewport: { width: 1280, height: 720 },
              verb: {
                name: "navigate",
                url: "/list.html",
                trigger: "load",
              },
              causedTraces: [],
              endAnchors: [],
              goneAnchors: [],
              settleMs: 0,
            } satisfies RecordedSemanticAction),
          },
        },
      ],
    });

    expect(bundle.steps).toHaveLength(1);
    expect(bundle.steps[0]?.action.endPath).toBe("/list.html");

    const pwSpec =
      compileSessionToPlaywright(bundle).files.find((f) => f.relativePath.endsWith(".spec.ts"))
        ?.content ?? "";
    expect(pwSpec).toContain(`getByRole("img"`);
    expect(pwSpec).toContain(`\\\\x22Logo\\\\x22`);
    expect(pwSpec).toContain(
      `await expect(page).toHaveURL(new RegExp("^https?:\\\\/\\\\/[^/?#]+/list\\\\.html(?:[?#]|$)"));`,
    );
    const listUrlRe = new RegExp("^https?:\\/\\/[^/?#]+/list\\.html(?:[?#]|$)");
    expect(listUrlRe.test("http://127.0.0.1:18080/list.html")).toBe(true);
    expect(listUrlRe.test("http://127.0.0.1:18080/index.html")).toBe(false);
    const rootUrlRe = new RegExp("^https?:\\/\\/[^/?#]+\\/?(?:[?#]|$)");
    expect(rootUrlRe.test("http://127.0.0.1:18080/")).toBe(true);
    expect(rootUrlRe.test("http://127.0.0.1:18080/login/")).toBe(false);

    const e2eSuite = compileSessionToE2E(bundle);
    const e2eSpec =
      e2eSuite.files.find((f) => f.relativePath.endsWith(".e2e.ts"))?.content ?? "";
    expect(e2eSpec).toContain(`await expect(app).toHaveURL(new RegExp("/list\\\\.html"));`);
    const parsedCache = z
      .object({
        payload: z.object({
          startPath: z.string().optional(),
          endPath: z.string().optional(),
        }),
      })
      .parse(JSON.parse(e2eSuite.cacheFiles[0]!.content));
    expect(parsedCache.payload.startPath).toBe("/index.html");
    expect(parsedCache.payload.endPath).toBe("/list.html");
  });
});
