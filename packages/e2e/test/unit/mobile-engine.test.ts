import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  defineEngine,
  resolveExpression,
  type EngineSnapshot,
  type SemanticNode,
} from "e2e/engine";
import { run as runE2ESuite } from "e2e/runner";
import type { MobileFixtures } from "@e2e-dev/mobile";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { BrowserAttemptLedger, parseW3cTraceparent } from "../../src/internal/correlator.js";
import { wrapEngineWithHostActionCapture } from "../../src/internal/host-action-exporter.js";
import {
  mergeBaggageHeader,
  setupAndroidAdbReverse,
  startMobileProxy,
} from "../../src/internal/mobile-proxy.js";
import {
  buildMobileCorrelationLaunchArguments,
  credentials,
  expect as mobileExpect,
  mobileTools,
  secrets,
  softprobeMobile,
  unique,
  wrapMobileEngine,
} from "../../src/mobile.js";
import { recordedSemanticActionSchema } from "../../src/session-compiler.js";

const PACKAGE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const REPO_ROOT = path.resolve(PACKAGE_DIR, "../..");

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function listenLocal(server: Server): Promise<{ readonly port: number; readonly origin: string }> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        reject(new Error("Expected numeric TCP address"));
        return;
      }
      const info: AddressInfo = addr;
      resolve({ port: info.port, origin: `http://127.0.0.1:${info.port}` });
    });
  });
}

function closeServer(server: Server | undefined): Promise<void> {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

const otlpExportRequestSchema = z.object({
  resourceSpans: z.array(
    z.object({
      resource: z
        .object({
          attributes: z.array(
            z.object({
              key: z.string(),
              value: z.record(z.string(), z.unknown()),
            }),
          ),
        })
        .optional(),
      scopeSpans: z.array(
        z.object({
          spans: z.array(
            z.object({
              traceId: z.string(),
              spanId: z.string(),
              name: z.string(),
              attributes: z.array(
                z.object({
                  key: z.string(),
                  value: z.object({
                    stringValue: z.string().optional(),
                    intValue: z.number().optional(),
                  }),
                }),
              ),
            }),
          ),
        }),
      ),
    }),
  ),
});

describe("mobile-proxy HTTP reverse proxy correlator and adb reverse helper", () => {
  const activeServers: Server[] = [];

  afterEach(async () => {
    while (activeServers.length > 0) {
      await closeServer(activeServers.pop());
    }
  });

  it("mints traceparent, preserves valid traceparent, injects session baggage, skips OPTIONS, and streams bodies", async () => {
    const receivedUpstream: Array<{
      readonly method: string;
      readonly url: string;
      readonly headers: Record<string, string | string[] | undefined>;
      readonly body: string;
    }> = [];

    const upstream = createServer(async (req, res) => {
      const body = await readBody(req);
      receivedUpstream.push({
        method: req.method ?? "GET",
        url: req.url ?? "/",
        headers: req.headers,
        body,
      });
      if (req.method === "OPTIONS") {
        res.writeHead(204, { "Access-Control-Allow-Origin": "*" });
        res.end();
        return;
      }
      res.writeHead(201, {
        "Content-Type": "application/json",
        "X-Upstream-Echo": "intact",
      });
      res.end(JSON.stringify({ ok: true, echoedBytes: Buffer.byteLength(body) }));
    });
    activeServers.push(upstream);
    const { origin: upstreamOrigin } = await listenLocal(upstream);

    const ledger = new BrowserAttemptLedger();
    const completedStatuses: Array<{ spanId: string; status?: number }> = [];
    const proxy = await startMobileProxy({
      upstreamOrigin,
      ledger,
      sessionId: "sp-e2e-attempt-01",
      onResponse: (entry) => {
        completedStatuses.push({ spanId: entry.spanId, status: entry.status });
      },
    });

    try {
      const optRes = await fetch(`${proxy.proxyOrigin}/api/invites`, {
        method: "OPTIONS",
      });
      expect(optRes.status).toBe(204);
      expect(ledger.rootView()).toHaveLength(0);

      const postRes = await fetch(`${proxy.proxyOrigin}/api/invites?channel=mobile`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          baggage: "env=ci",
        },
        body: JSON.stringify({ email: "ada@acme.com" }),
      });
      expect(postRes.status).toBe(201);
      expect(postRes.headers.get("x-upstream-echo")).toBe("intact");
      expect(await postRes.json()).toEqual({
        ok: true,
        echoedBytes: Buffer.byteLength(JSON.stringify({ email: "ada@acme.com" })),
      });

      expect(ledger.rootView()).toHaveLength(1);
      const firstRecorded = ledger.rootView()[0]!;
      expect(firstRecorded.headerSource).toBe("minted");
      expect(firstRecorded.pathname).toBe("/api/invites");
      expect(completedStatuses).toEqual([
        { spanId: firstRecorded.spanId, status: 201 },
      ]);

      const upstreamFirst = receivedUpstream[1]!;
      const upstreamTp = parseW3cTraceparent(
        typeof upstreamFirst.headers["traceparent"] === "string"
          ? upstreamFirst.headers["traceparent"]
          : undefined,
      );
      expect(upstreamTp?.traceId).toBe(firstRecorded.traceId);
      expect(upstreamFirst.headers["baggage"]).toBe(
        "env=ci,sp.session.id=sp-e2e-attempt-01",
      );

      const explicitTraceId = "11223344556677889900aabbccddeeff";
      const explicitSpanId = "1122334455667788";
      const explicitTp = `00-${explicitTraceId}-${explicitSpanId}-01`;
      const secondRes = await fetch(`${proxy.proxyOrigin}/api/invites`, {
        method: "POST",
        headers: {
          traceparent: explicitTp,
        },
        body: "{}",
      });
      expect(secondRes.status).toBe(201);
      expect(ledger.rootView()).toHaveLength(2);
      expect(ledger.rootView()[1]?.traceId).toBe(explicitTraceId);
      expect(ledger.rootView()[1]?.headerSource).toBe("preserved");
      expect(receivedUpstream[2]?.headers["traceparent"]).toBe(explicitTp);
    } finally {
      await proxy.close();
      await proxy.close();
    }
  });

  it("manages idempotent Android adb reverse setup and cleanup targeting the bound serial", () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const handle = setupAndroidAdbReverse({
      port: 43199,
      serial: "emulator-5554",
      runCommand: (file, args) => {
        calls.push({ file, args });
      },
    });

    expect(calls).toEqual([
      {
        file: "adb",
        args: ["-s", "emulator-5554", "reverse", "tcp:43199", "tcp:43199"],
      },
    ]);

    handle.cleanup();
    handle.cleanup();
    expect(calls).toEqual([
      {
        file: "adb",
        args: ["-s", "emulator-5554", "reverse", "tcp:43199", "tcp:43199"],
      },
      {
        file: "adb",
        args: ["-s", "emulator-5554", "reverse", "--remove", "tcp:43199"],
      },
    ]);

    expect(mergeBaggageHeader("sp.session.id=old,foo=bar", "new-sess")).toBe(
      "foo=bar,sp.session.id=new-sess",
    );
  });
});

describe("host-action-exporter tree diffing, secret redaction, causedTraces, and OTLP export", () => {
  const activeServers: Server[] = [];

  afterEach(async () => {
    while (activeServers.length > 0) {
      await closeServer(activeServers.pop());
    }
  });

  it("diffs pre/post trees filtering volatile clocks, redacts secrets, maps gestures, links causedTraces, and exports OTLP /v1/traces", async () => {
    const exportedBatches: Array<{
      readonly auth: string | undefined;
      readonly workspace: string | undefined;
      readonly bodyText: string;
    }> = [];

    const collector = createServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/v1/traces") {
        const bodyText = await readBody(req);
        exportedBatches.push({
          auth: req.headers.authorization,
          workspace:
            typeof req.headers["x-workspace-id"] === "string"
              ? req.headers["x-workspace-id"]
              : undefined,
          bodyText,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
        return;
      }
      res.writeHead(404);
      res.end();
    });
    activeServers.push(collector);
    const { origin: collectorOrigin } = await listenLocal(collector);

    let currentStage: "initial" | "filled" | "submitted" | "linked" | "backed" = "initial";
    const makeTree = (): EngineSnapshot => {
      const clockNode: SemanticNode = {
        ref: { id: "n_clock", revision: "r1" },
        role: "text",
        text: currentStage === "initial" ? "10:41 AM" : "10:42 AM",
      };
      const emailNode: SemanticNode = {
        ref: { id: "n_email", revision: "r1" },
        role: "textbox",
        name: "Teammate email",
        testId: "com.softprobe.fixture.invite:id/email_input",
        attributes: { placeholder: "Teammate email" },
        states: { focused: true },
        rect: { x: 28, y: 120, width: 334, height: 56 },
        ...(currentStage !== "initial" ? { value: "ada@acme.com" } : {}),
      };
      const passwordNode: SemanticNode = {
        ref: { id: "n_pw", revision: "r1" },
        role: "textbox",
        name: "Admin password",
        testId: "com.softprobe.fixture.invite:id/password_input",
        inputPurpose: "password",
        states: { secure: true },
        rect: { x: 28, y: 192, width: 334, height: 56 },
      };
      const submitNode: SemanticNode = {
        ref: { id: "n_submit", revision: "r1" },
        role: "button",
        name: "Send invite",
        testId: "com.softprobe.fixture.invite:id/send_invite_button",
        rect: { x: 28, y: 268, width: 334, height: 56 },
      };
      const idleHintNode: SemanticNode = {
        ref: { id: "n_idle", revision: "r1" },
        role: "text",
        text: "Enter details to invite a teammate",
        testId: "com.softprobe.fixture.invite:id/idle_hint",
      };
      const statusBannerNode: SemanticNode = {
        ref: { id: "n_banner", revision: "r1" },
        role: "status",
        name: "Invitation queued for ada@acme.com",
        testId: "com.softprobe.fixture.invite:id/status_banner",
      };

      const children: SemanticNode[] = [clockNode, emailNode, passwordNode, submitNode];
      if (currentStage === "initial" || currentStage === "filled") {
        children.push(idleHintNode);
      }
      if (currentStage === "submitted" || currentStage === "linked") {
        children.push(statusBannerNode);
      }

      const location =
        currentStage === "linked"
          ? "com.softprobe.fixture.invite / InviteDetails"
          : "com.softprobe.fixture.invite / Team Invite";

      return {
        location,
        viewport: { width: 390.4, height: 844.2 },
        root: {
          ref: { id: "root", revision: "r1" },
          role: "application",
          children,
        },
      };
    };

    const ledger = new BrowserAttemptLedger();
    const rawSecretValue = "top_secret_pw_998877!";

    const scriptedBase = defineEngine({
      name: "mobile",
      version: "0.12.8",
      spiVersion: 1,
      platform: "android",
      actions: ["tap", "fill", "longPress", "swipe"],
      pointerActions: ["tap", "swipeTo"],
      startAttempt: async () => undefined,
      endAttempt: async () => undefined,
      observe: async () => makeTree(),
      locate: async () => makeTree().root.children ?? [],
      perform: async (ref, action) => {
        if (ref.id === "n_pw" && action.kind === "fill") {
          currentStage = "filled";
        } else if (ref.id === "n_submit" && action.kind === "tap") {
          currentStage = "submitted";
          ledger.recordRequest({
            method: "POST",
            url: "http://127.0.0.1:18088/api/invites",
            headers: {},
          });
        }
      },
      performAt: async () => undefined,
      keyboard: {
        type: async () => undefined,
        press: async () => undefined,
        dismiss: async () => undefined,
      },
      session: {
        back: async () => {
          currentStage = "backed";
        },
        openLink: async () => {
          currentStage = "linked";
        },
      },
    });

    const { engine, exporter } = wrapEngineWithHostActionCapture(scriptedBase, {
      platform: "android",
      resolveAttemptBinding: () => ({
        sessionId: "sp-e2e-unit-session-1",
        ledger,
        sink: {
          endpoint: collectorOrigin,
          token: "bb_unit_tok",
          workspaceId: "ws_unit_1",
          serviceName: "invite-android-e2e",
        },
        env: {
          E2E_SECRET_ADMIN_PASSWORD: rawSecretValue,
        },
      }),
    });

    const op = {
      signal: new AbortController().signal,
      timeoutMs: 5_000,
      runId: "run-1",
      attemptId: "att-1",
      origin: "agent" as const,
    };

    await engine.startAttempt!({
      attemptId: "att-1",
      artifactsDir: os.tmpdir(),
      resolveSecret: async () => "",
      signal: op.signal,
      appLog: () => undefined,
      navigation: () => undefined,
      environment: () => undefined,
    });

    await engine.observe!(op);
    await engine.perform!(
      { id: "n_email", revision: "r1" },
      { kind: "fill", value: "ada@acme.com", sensitive: false },
      op,
    );
    await engine.observe!(op);
    await engine.perform!(
      { id: "n_pw", revision: "r1" },
      { kind: "fill", value: rawSecretValue, sensitive: true },
      op,
    );
    await engine.observe!(op);
    await engine.keyboard!.dismiss!(op);
    await engine.observe!(op);
    await engine.perform!(
      { id: "root", revision: "r1" },
      { kind: "swipe", direction: "up" },
      op,
    );
    await engine.observe!(op);
    await engine.perform!(
      { id: "n_submit", revision: "r1" },
      { kind: "tap" },
      op,
    );
    const createdTrigger = ledger.rootView()[0]!;
    exporter.recordResponseStatus(createdTrigger.spanId, 200);
    await engine.observe!(op);

    await engine.session!.openLink!("softprobe://invites/42", op);
    await engine.observe!(op);
    await engine.session!.back!(op);
    await engine.observe!(op);

    await engine.endAttempt!({ signal: op.signal, timeoutMs: 5_000 });

    expect(exportedBatches).toHaveLength(1);
    const exported = exportedBatches[0]!;
    expect(exported.auth).toBe("Bearer bb_unit_tok");
    expect(exported.workspace).toBe("ws_unit_1");
    expect(exported.bodyText).not.toContain(rawSecretValue);

    const parsedOtlp = otlpExportRequestSchema.parse(JSON.parse(exported.bodyText));
    const spans = parsedOtlp.resourceSpans[0]!.scopeSpans[0]!.spans;
    expect(spans).toHaveLength(7);

    const decodedActions = spans.map((sp) => {
      const attrs = Object.fromEntries(
        sp.attributes.map((kv) => [
          kv.key,
          kv.value.stringValue ?? String(kv.value.intValue ?? ""),
        ]),
      );
      expect(sp.name).toBe("softprobe.ui.action");
      expect(attrs["sp.observation.type"]).toBe("ui_action");
      expect(attrs["sp.ui.action.schema"]).toBe("sp-ui-action-1");
      expect(attrs["sp.session.id"]).toBe("sp-e2e-unit-session-1");
      const rawPayload = attrs["sp.ui.action.payload"] ?? "";
      expect(rawPayload.startsWith("sp.json:")).toBe(true);
      return recordedSemanticActionSchema.parse(
        JSON.parse(rawPayload.slice("sp.json:".length)),
      );
    });

    expect(decodedActions.map((a) => a.verb.name)).toEqual([
      "fill",
      "fill",
      "dismissKeyboard",
      "swipe",
      "click",
      "openLink",
      "back",
    ]);

    for (const act of decodedActions) {
      expect(act.platform).toBe("android");
      expect(act.captureSource).toBe("host_agent");
      expect(act.viewport).toEqual({ width: 390, height: 844 });
    }

    const emailFill = decodedActions[0]!;
    expect(emailFill.verb).toMatchObject({
      name: "fill",
      value: { kind: "literal", value: "ada@acme.com" },
    });

    const secretFill = decodedActions[1]!;
    expect(secretFill.verb).toMatchObject({
      name: "fill",
      value: { kind: "secret", slot: "ADMIN_PASSWORD" },
    });

    const submitTap = decodedActions[4]!;
    expect(submitTap.causedTraces).toEqual([
      {
        traceId: createdTrigger.traceId,
        spanId: createdTrigger.spanId,
        method: "POST",
        url: "http://127.0.0.1:18088/api/invites",
        status: 200,
      },
    ]);
    expect(submitTap.endAnchors).toEqual([
      {
        testId: "com.softprobe.fixture.invite:id/status_banner",
        accessibilityId: "com.softprobe.fixture.invite:id/status_banner",
        role: "status",
        name: "Invitation queued for ada@acme.com",
      },
    ]);
    expect(submitTap.goneAnchors).toEqual([
      {
        testId: "com.softprobe.fixture.invite:id/idle_hint",
        accessibilityId: "com.softprobe.fixture.invite:id/idle_hint",
        role: "text",
        text: "Enter details to invite a teammate",
      },
    ]);
  });
});

describe("@softprobe/e2e/mobile public entrypoint in proxy and session modes", () => {
  const activeServers: Server[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (activeServers.length > 0) {
      await closeServer(activeServers.pop());
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("formats Android --es and iOS -flag launchArguments and wraps mobileTools handles", () => {
    expect(
      buildMobileCorrelationLaunchArguments({
        platform: "android",
        existingArgs: ["--ez", "debug", "true", "--es", "api_base_url", "http://old"],
        correlation: { mode: "proxy", upstreamOrigin: "http://127.0.0.1:9000" },
        proxyOrigin: "http://127.0.0.1:54321",
        sessionId: "sp-e2e-1",
      }),
    ).toEqual(["--ez", "debug", "true", "--es", "api_base_url", "http://127.0.0.1:54321"]);

    expect(
      buildMobileCorrelationLaunchArguments({
        platform: "ios",
        existingArgs: ["-FIRDebugEnabled"],
        correlation: { mode: "proxy", upstreamOrigin: "http://127.0.0.1:9000" },
        proxyOrigin: "http://127.0.0.1:54321",
        sessionId: "sp-e2e-1",
      }),
    ).toEqual(["-FIRDebugEnabled", "-API_BASE_URL", "http://127.0.0.1:54321"]);

    expect(
      buildMobileCorrelationLaunchArguments({
        platform: "ios",
        existingArgs: [],
        correlation: { mode: "session" },
        proxyOrigin: undefined,
        sessionId: "sp-e2e-att-9",
      }),
    ).toEqual(["-spSessionId", "sp-e2e-att-9"]);

    const handle = softprobeMobile({
      platform: "android",
      correlation: { mode: "proxy", upstreamOrigin: "http://127.0.0.1:18088" },
    });
    const tools = mobileTools(handle);
    expect(Object.keys(tools).sort()).toEqual(["alert", "open_app", "swipe"]);
    expect(typeof mobileExpect).toBe("function");
    expect(typeof secrets.get).toBe("function");
    expect(typeof credentials.user).toBe("function");
    expect(typeof unique).toBe("function");
  });

  it(
    "runs e2e suite end-to-end with scripted mobile engine in both proxy and session correlation modes",
    async () => {
    const tracesById = new Map<string, unknown>();
    const sessionSpansById = new Map<string, Array<Record<string, unknown>>>();
    const exportedUiSpans: Array<Record<string, unknown>> = [];

    const downstreamServer = createServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/v1/email/send") {
        await readBody(req);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ queued: true }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    activeServers.push(downstreamServer);
    const { origin: downstreamOrigin } = await listenLocal(downstreamServer);

    const inviteBackend = createServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/api/invites") {
        const raw = await readBody(req);
        const parsed = JSON.parse(raw || "{}") as { email?: string };
        const tp = parseW3cTraceparent(
          typeof req.headers["traceparent"] === "string"
            ? req.headers["traceparent"]
            : undefined,
        );
        const traceId = tp?.traceId ?? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        const parentSpanId = tp?.spanId ?? "bbbbbbbbbbbbbbbb";
        const serverSpanId = "cccccccccccccccc";
        const clientSpanId = "dddddddddddddddd";

        if (parsed.email === "existing@acme.com") {
          tracesById.set(traceId, {
            spans: [
              {
                trace_id: traceId,
                span_id: serverSpanId,
                parent_span_id: parentSpanId,
                name: "POST /api/invites",
                kind: "SERVER",
                service_name: "invite-api",
                attributes: {
                  "http.request.method": "POST",
                  "url.path": "/api/invites",
                  "http.response.status_code": 409,
                },
              },
            ],
          });
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Already a member" }));
          return;
        }

        const outboundBody = JSON.stringify({ to: parsed.email ?? "ada@acme.com" });
        await fetch(`${downstreamOrigin}/v1/email/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: outboundBody,
        });

        tracesById.set(traceId, {
          spans: [
            {
              trace_id: traceId,
              span_id: serverSpanId,
              parent_span_id: parentSpanId,
              name: "POST /api/invites",
              kind: "SERVER",
              service_name: "invite-api",
              attributes: {
                "http.request.method": "POST",
                "url.path": "/api/invites",
                "http.response.status_code": 200,
              },
            },
            {
              trace_id: traceId,
              span_id: clientSpanId,
              parent_span_id: serverSpanId,
              name: "POST",
              kind: "CLIENT",
              service_name: "invite-api",
              attributes: {
                "http.request.method": "POST",
                "url.full": `${downstreamOrigin}/v1/email/send`,
                "http.response.status_code": 200,
                "http.request.body": outboundBody,
              },
            },
          ],
        });

        const baggageHeader =
          typeof req.headers["baggage"] === "string" ? req.headers["baggage"] : "";
        const sessMatch = /sp\.session\.id=([^,\s]+)/.exec(baggageHeader);
        if (sessMatch?.[1]) {
          const sid = sessMatch[1];
          const list = sessionSpansById.get(sid) ?? [];
          list.push({
            trace_id: traceId,
            span_id: parentSpanId,
            session_id: sid,
            name: "POST",
            kind: "CLIENT",
            start_time: new Date().toISOString(),
            attributes: {
              "http.request.method": "POST",
              "url.full": "http://10.0.2.2:18088/api/invites",
              "http.response.status_code": 200,
            },
          });
          sessionSpansById.set(sid, list);
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    activeServers.push(inviteBackend);
    const { origin: inviteOrigin } = await listenLocal(inviteBackend);

    const blackboxSinkServer = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "POST" && url.pathname === "/v1/traces") {
        const text = await readBody(req);
        exportedUiSpans.push(JSON.parse(text) as Record<string, unknown>);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
        return;
      }
      const traceMatch = /^\/api\/traces\/([0-9a-f]{32})$/.exec(url.pathname);
      if (req.method === "GET" && traceMatch) {
        const stored = tracesById.get(traceMatch[1]!);
        if (!stored) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end("{}");
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(stored));
        return;
      }
      const sessionMatch = /^\/v1\/llm\/sessions\/([^/]+)$/.exec(url.pathname);
      if (req.method === "GET" && sessionMatch) {
        const sid = decodeURIComponent(sessionMatch[1]!);
        const spans = sessionSpansById.get(sid);
        if (!spans) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end("{}");
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ session_id: sid, spans }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    activeServers.push(blackboxSinkServer);
    const { origin: blackboxOrigin } = await listenLocal(blackboxSinkServer);

    const projectDir = mkdtempSync(path.join(os.tmpdir(), "sp-mobile-unit-suite-"));
    tempDirs.push(projectDir);
    symlinkSync(
      path.join(REPO_ROOT, "node_modules"),
      path.join(projectDir, "node_modules"),
      "dir",
    );

    const adbCallsPath = path.join(projectDir, "adb-calls.jsonl");
    const configPath = path.join(projectDir, "e2e.config.ts");
    writeFileSync(
      configPath,
      `import { appendFileSync } from "node:fs";
import type { E2EConfig } from "e2e";
import {
  defineEngine,
  resolveExpression,
  type EngineSnapshot,
  type SemanticNode,
} from "e2e/engine";
import { wrapMobileEngine, type MobileFixtures } from "@softprobe/e2e/mobile";

function createScriptedMobileSurface(defaultUpstream: string) {
  let appRef: { readonly launchArguments?: readonly string[] } | undefined;
  let currentAppArgs: readonly string[] = [];
  let typedEmail = "";
  let bannerText = "";

  const getLaunchExtra = (key: string): string | undefined => {
    for (let i = 0; i < currentAppArgs.length; i += 1) {
      if (currentAppArgs[i] === "--es" && currentAppArgs[i + 1] === key) {
        return currentAppArgs[i + 2];
      }
    }
    return undefined;
  };

  const snapshotNow = (): EngineSnapshot => ({
    location: "com.softprobe.fixture.invite / Team Invite",
    viewport: { width: 390, height: 844 },
    root: {
      ref: { id: "root", revision: "r1" },
      role: "application",
      children: [
        {
          ref: { id: "email", revision: "r1" },
          role: "textbox",
          name: "Teammate email",
          testId: "email_input",
          value: typedEmail,
          rect: { x: 20, y: 100, width: 300, height: 48 },
        },
        {
          ref: { id: "send", revision: "r1" },
          role: "button",
          name: "Send invite",
          testId: "send_invite_button",
          rect: { x: 20, y: 200, width: 300, height: 48 },
        },
        ...(bannerText
          ? [
              {
                ref: { id: "banner", revision: "r1" },
                role: "status",
                name: bannerText,
                text: bannerText,
                testId: "status_banner",
                rect: { x: 20, y: 280, width: 300, height: 48 },
              } satisfies SemanticNode,
            ]
          : []),
      ],
    },
  });

  return defineEngine<MobileFixtures>({
    name: "mobile",
    version: "0.12.8",
    spiVersion: 1,
    platform: "android",
    isolation: "worker",
    actions: ["tap", "fill"],
    init: async (info) => {
      appRef = info.app;
      currentAppArgs = info.app.launchArguments ?? [];
    },
    startAttempt: async () => {
      typedEmail = "";
      bannerText = "";
    },
    endAttempt: async () => undefined,
    observe: async () => snapshotNow(),
    locate: async (expr) => {
      const snap = snapshotNow();
      return resolveExpression(expr, [snap.root]);
    },
    perform: async (ref, action) => {
      if (ref.id === "email" && action.kind === "fill") {
        typedEmail = action.value;
        return;
      }
      if (ref.id === "send" && action.kind === "tap") {
        currentAppArgs = appRef?.launchArguments ?? [];
        const baseUrl = getLaunchExtra("api_base_url") ?? defaultUpstream;
        const sessionExtra = getLaunchExtra("sp_session_id");
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (sessionExtra) {
          headers["baggage"] = \`sp.session.id=\${sessionExtra}\`;
          headers["traceparent"] =
            "00-abcdef0123456789abcdef0123456789-1234567890abcdef-01";
        }
        const res = await fetch(\`\${baseUrl}/api/invites\`, {
          method: "POST",
          headers,
          body: JSON.stringify({ email: typedEmail }),
        });
        bannerText = res.ok
          ? \`Invitation queued for \${typedEmail}\`
          : "Error: Already a member";
      }
    },
    session: {
      restart: async () => {
        currentAppArgs = appRef?.launchArguments ?? [];
        typedEmail = "";
        bannerText = "";
      },
    },
    fixtures: {
      device: (ctx) => ctx.fixture("device", {} as MobileFixtures["device"], {}),
    },
  });
}

const inviteOrigin = ${JSON.stringify(inviteOrigin)};
const blackboxOrigin = ${JSON.stringify(blackboxOrigin)};
const adbCallsPath = ${JSON.stringify(adbCallsPath)};

export default {
  projectId: "sp-mobile-unit-modes",
  workers: 1,
  retries: 0,
  tests: "*.e2e.ts",
  targets: [
    {
      name: "android-proxy",
      engine: wrapMobileEngine(
        createScriptedMobileSurface(inviteOrigin),
        {
          platform: "android",
          device: "10.0.0.99:5555",
          endpoint: blackboxOrigin,
          token: "tok_unit",
          workspaceId: "ws_unit",
          correlation: {
            mode: "proxy",
            upstreamOrigin: inviteOrigin,
          },
          pollTimeoutMs: 3_000,
          pollIntervalMs: 40,
          settleMs: 30,
        },
        {
          runAdbCommand: (_file, args) => {
            appendFileSync(adbCallsPath, JSON.stringify(args) + "\\n", "utf8");
          },
        },
      ),
      app: { bundleId: "com.softprobe.fixture.invite" },
    },
    {
      name: "android-session",
      engine: wrapMobileEngine(
        createScriptedMobileSurface(inviteOrigin),
        {
          platform: "android",
          endpoint: blackboxOrigin,
          token: "tok_unit",
          workspaceId: "ws_unit",
          correlation: {
            mode: "session",
          },
          pollTimeoutMs: 3_000,
          pollIntervalMs: 40,
          settleMs: 30,
        },
      ),
      app: { bundleId: "com.softprobe.fixture.invite" },
    },
  ],
} satisfies E2EConfig;
`,
      "utf8",
    );

    writeFileSync(
      path.join(projectDir, "invite.e2e.ts"),
      `import { expect, test } from "@softprobe/e2e/mobile";

test("verifies outboundHttp across proxy and session modes", async ({ app, screen, trace }) => {
  await app.open();
  await screen.getByLabel("Teammate email").fill("ada@acme.com");
  await screen.getByRole("button", "Send invite").tap();
  await expect(screen.getByText("Invitation queued for ada@acme.com")).toBeVisible();

  const call = await trace.outboundHttp({
    triggeredBy: { method: "POST", path: "/api/invites" },
    method: "POST",
    url: /\\/v1\\/email\\/send$/,
    status: 200,
  });
  expect(call.request.json).toEqual({ to: "ada@acme.com" });
});
`,
      "utf8",
    );

    const prevTelemetry = process.env.E2E_TELEMETRY_DISABLED;
    process.env.E2E_TELEMETRY_DISABLED = "1";
    try {
      const outcome = await runE2ESuite({
        cwd: projectDir,
        config: configPath,
      });
      expect(outcome.status).toBe("passed");
      expect(outcome.exitCode).toBe(0);
      expect(outcome.report.run.summary.passed).toBe(2);
    } finally {
      if (prevTelemetry === undefined) {
        delete process.env.E2E_TELEMETRY_DISABLED;
      } else {
        process.env.E2E_TELEMETRY_DISABLED = prevTelemetry;
      }
    }

    const adbCalls = readFileSync(adbCallsPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    expect(adbCalls.length).toBe(2);
    expect(adbCalls[0]?.slice(0, 3)).toEqual(["-s", "10.0.0.99:5555", "reverse"]);
    expect(adbCalls[1]?.slice(0, 4)).toEqual([
      "-s",
      "10.0.0.99:5555",
      "reverse",
      "--remove",
    ]);
    expect(exportedUiSpans.length).toBeGreaterThanOrEqual(2);
    },
    30_000,
  );
});
