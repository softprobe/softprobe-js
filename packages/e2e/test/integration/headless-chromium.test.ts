import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run as runE2ESuite } from "e2e/runner";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { isTraceId } from "../../src/index.js";

const PACKAGE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const REPO_ROOT = path.resolve(PACKAGE_DIR, "../..");
const WEB_RECORD_BUNDLE_PATH = path.join(
  REPO_ROOT,
  "packages/web-record/dist/browser.js",
);
const EVIDENCE_DIR = "/tmp/verify-softprobe-js-evidence";

interface RecordedApiHit {
  readonly method: string;
  readonly pathname: string;
  readonly traceparentHeaders: readonly string[];
  readonly bodyText: string;
}

interface StoredEmailSubmission {
  readonly to: ReadonlyArray<{ readonly address: string }>;
  readonly subject: string;
  readonly html: string;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function collectTraceparentRawHeaders(rawHeaders: readonly string[]): string[] {
  const values: string[] = [];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i];
    const val = rawHeaders[i + 1];
    if (name?.toLowerCase() === "traceparent" && val !== undefined) {
      values.push(val);
    }
  }
  return values;
}

function listenEphemeral(server: Server): Promise<{
  readonly port: number;
  readonly origin: string;
}> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        reject(new Error("Expected numeric TCP address"));
        return;
      }
      const info: AddressInfo = addr;
      resolve({
        port: info.port,
        origin: `http://127.0.0.1:${info.port}`,
      });
    });
  });
}

function closeServer(server: Server | undefined): Promise<void> {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function randomSpanHex(): string {
  return randomBytes(8).toString("hex");
}

const softprobeTracesReportSchema = z.object({
  schemaVersion: z.literal("softprobe-traces-1"),
  runId: z.string(),
  traces: z.array(
    z.object({
      traceId: z.string(),
      sinkKind: z.enum(["blackbox", "arex"]),
      mode: z.enum(["outboundHttp", "expectNoOutboundHttp"]),
      triggeredBy: z.object({
        method: z.string(),
        pathname: z.string(),
        headerSource: z.enum(["preserved", "minted"]),
      }),
      outboundCall: z
        .object({
          method: z.string(),
          url: z.string(),
          status: z.number(),
        })
        .optional(),
      explorerTraceUrl: z.string().optional(),
    }),
  ),
});

describe("Headless Chromium full-stack E2E integration", () => {
  const previousTelemetryEnv = process.env.E2E_TELEMETRY_DISABLED;
  let emailServer: Server | undefined;
  let blackboxServer: Server | undefined;
  let arexServer: Server | undefined;
  let appServer: Server | undefined;

  let emailOrigin = "";
  let blackboxOrigin = "";
  let arexOrigin = "";
  let appOrigin = "";

  const blackboxTraces = new Map<string, unknown>();
  const arexTraces = new Map<string, unknown>();
  const apiHits: RecordedApiHit[] = [];
  const emailSubmissions: StoredEmailSubmission[] = [];
  const tempDirs: string[] = [];

  beforeAll(async () => {
    process.env.E2E_TELEMETRY_DISABLED = "1";

    emailServer = createServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/v1/account/invite/submit") {
        const raw = await readBody(req);
        const parsed = z
          .object({
            subject: z.string(),
            to: z.array(z.object({ address: z.string() })),
            html: z.string(),
          })
          .safeParse(JSON.parse(raw));
        if (parsed.success) {
          emailSubmissions.push(parsed.data);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            messageId: `msg_${emailSubmissions.length}`,
            accepted: true,
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const emailBound = await listenEphemeral(emailServer);
    emailOrigin = emailBound.origin;

    blackboxServer = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        });
        res.end();
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/traces") {
        await readBody(req);
        res.writeHead(200, {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": "application/json",
        });
        res.end("{}");
        return;
      }
      const traceMatch = /^\/api\/traces\/([0-9a-f]{32})$/.exec(url.pathname);
      if (req.method === "GET" && traceMatch) {
        if (req.headers.authorization !== "Bearer bb_int_token") {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "unauthorized" }));
          return;
        }
        if (req.headers["x-workspace-id"] !== "ws_int_001") {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "missing workspace header" }));
          return;
        }
        const traceId = traceMatch[1]!;
        const stored = blackboxTraces.get(traceId);
        if (!stored) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "trace not found" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(stored));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const blackboxBound = await listenEphemeral(blackboxServer);
    blackboxOrigin = blackboxBound.origin;

    arexServer = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const outboundMatch = /^\/api\/traces\/([0-9a-f]{32})\/outbound-http$/.exec(
        url.pathname,
      );
      if (req.method === "GET" && outboundMatch) {
        if (req.headers.authorization !== "Bearer arex_int_token") {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "unauthorized" }));
          return;
        }
        if (url.searchParams.get("appId") !== "demo-app") {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "forbidden appId" }));
          return;
        }
        const traceId = outboundMatch[1]!;
        const stored = arexTraces.get(traceId);
        if (!stored) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              body: {
                traceId,
                state: "awaiting_server_span",
                outboundHttp: [],
              },
            }),
          );
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ body: stored }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const arexBound = await listenEphemeral(arexServer);
    arexOrigin = arexBound.origin;

    const webRecordBundle = readFileSync(WEB_RECORD_BUNDLE_PATH, "utf8");

    appServer = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");

      if (req.method === "GET" && url.pathname === "/sdk/web-record.js") {
        res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
        res.end(webRecordBundle);
        return;
      }

      if (req.method === "GET" && url.pathname === "/with-web-record") {
        const sdkOpts = JSON.stringify({
          ingestionKey: "sp_int_key",
          serviceName: "demo-browser",
          otlp: { tracesEndpoint: `${blackboxOrigin}/v1/traces` },
        });
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>With Web Record</title>
    <script src="/sdk/web-record.js" data-softprobe-options='${sdkOpts}'></script>
  </head>
  <body>
    <button id="ping-btn" type="button">Send instrumented ping</button>
    <div role="status" id="ping-status">Ready</div>
    <script>
      document.getElementById("ping-btn").addEventListener("click", async () => {
        const r = await fetch("/api/ping", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "webrecord@softprobe.ai" }),
        });
        const data = await r.json();
        document.getElementById("ping-status").textContent = "Recorded " + data.traceId;
      });
    </script>
  </body>
</html>`);
        return;
      }

      if (req.method === "GET" && url.pathname === "/without-web-record") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>Without Web Record</title></head>
  <body>
    <button id="ping-btn" type="button">Send plain ping</button>
    <div role="status" id="ping-status">Ready</div>
    <script>
      document.getElementById("ping-btn").addEventListener("click", async () => {
        const r = await fetch("/api/ping", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "minted@softprobe.ai" }),
        });
        const data = await r.json();
        document.getElementById("ping-status").textContent = "Minted " + data.traceId;
      });
    </script>
  </body>
</html>`);
        return;
      }

      if (req.method === "GET" && url.pathname === "/invite") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>Workspace Members</title></head>
  <body>
    <h1>Workspace Members</h1>
    <label for="invite-email">Email address</label>
    <input id="invite-email" name="email" type="email" placeholder="colleague@example.com" />
    <button id="send-invite" type="button">Send invitation</button>
    <button id="resend-invite" type="button">Resend</button>
    <div role="status" id="invite-banner">Idle</div>
    <section id="pending-section" aria-label="Pending invitations"></section>
    <script>
      document.getElementById("send-invite").addEventListener("click", async () => {
        const email = document.getElementById("invite-email").value.trim();
        const postRes = await fetch("/api/workspaces/ws_alpha/invites", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, workspace: "Alpha Workspace" }),
        });
        await Promise.all([
          fetch("/api/workspaces/ws_alpha/members"),
          fetch("/api/workspaces/ws_alpha/invites"),
        ]);
        if (postRes.status === 409) {
          document.getElementById("invite-banner").textContent =
            email + " is already an active workspace member.";
          return;
        }
        document.getElementById("invite-banner").textContent =
          "Invitation email sent to " + email + ".";
        const row = document.createElement("div");
        row.innerHTML = '<span>' + email + '</span> <button type="button">Revoke</button>';
        document.getElementById("pending-section").replaceChildren(row);
      });

      document.getElementById("resend-invite").addEventListener("click", async () => {
        const email = document.getElementById("invite-email").value.trim() || "resend@softprobe.ai";
        await fetch("/api/workspaces/ws_alpha/invites?resend=1", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, workspace: "Alpha Workspace" }),
        });
        document.getElementById("invite-banner").textContent =
          "A new invitation email was sent to " + email + ".";
      });
    </script>
  </body>
</html>`);
        return;
      }

      if (req.method === "GET" && url.pathname === "/uninstrumented") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>Uninstrumented Endpoint</title></head>
  <body>
    <button id="fire-uninstrumented" type="button">Fire uninstrumented call</button>
    <div role="status" id="uninstrumented-status">Idle</div>
    <script>
      document.getElementById("fire-uninstrumented").addEventListener("click", async () => {
        await fetch("/api/workspaces/ws_alpha/uninstrumented", { method: "POST" });
        document.getElementById("uninstrumented-status").textContent = "Done";
      });
    </script>
  </body>
</html>`);
        return;
      }

      if (url.pathname.startsWith("/api/")) {
        const bodyText = await readBody(req);
        const traceparentHeaders = collectTraceparentRawHeaders(req.rawHeaders);
        apiHits.push({
          method: req.method ?? "GET",
          pathname: url.pathname,
          traceparentHeaders,
          bodyText,
        });

        const tp = traceparentHeaders[0] ?? "";
        const tpParts = tp.split("-");
        const traceId = tpParts[1] ?? "";
        const incomingSpanId = tpParts[2] ?? randomSpanHex();

        if (url.pathname.endsWith("/uninstrumented")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        if (req.method === "GET") {
          const serverSpanId = randomSpanHex();
          if (isTraceId(traceId)) {
            blackboxTraces.set(traceId, {
              batches: [
                {
                  resource: {
                    attributes: [
                      { key: "service.name", value: { stringValue: "demo-backend" } },
                    ],
                  },
                  scopeSpans: [
                    {
                      spans: [
                        {
                          traceId,
                          spanId: serverSpanId,
                          parentSpanId: incomingSpanId,
                          name: `GET ${url.pathname}`,
                          kind: 2,
                          startTimeUnixNano: "1700000000000000000",
                          endTimeUnixNano: "1700000000005000000",
                          attributes: [
                            { key: "http.request.method", value: { stringValue: "GET" } },
                            { key: "url.path", value: { stringValue: url.pathname } },
                            { key: "http.response.status_code", value: { intValue: 200 } },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            });
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ items: [] }));
          return;
        }

        let email = "unknown@softprobe.ai";
        let workspace = "Alpha Workspace";
        try {
          const parsedBody = z
            .object({
              email: z.string().optional(),
              workspace: z.string().optional(),
            })
            .safeParse(bodyText ? JSON.parse(bodyText) : {});
          if (parsedBody.success) {
            if (parsedBody.data.email) email = parsedBody.data.email;
            if (parsedBody.data.workspace) workspace = parsedBody.data.workspace;
          }
        } catch {}

        const serverSpanId = randomSpanHex();

        if (email === "owner@softprobe.ai") {
          if (isTraceId(traceId)) {
            blackboxTraces.set(traceId, {
              batches: [
                {
                  resource: {
                    attributes: [
                      { key: "service.name", value: { stringValue: "demo-backend" } },
                    ],
                  },
                  scopeSpans: [
                    {
                      spans: [
                        {
                          traceId,
                          spanId: serverSpanId,
                          parentSpanId: incomingSpanId,
                          name: `POST ${url.pathname}`,
                          kind: 2,
                          startTimeUnixNano: "1700000000000000000",
                          endTimeUnixNano: "1700000000008000000",
                          attributes: [
                            { key: "http.request.method", value: { stringValue: "POST" } },
                            { key: "url.path", value: { stringValue: url.pathname } },
                            { key: "http.response.status_code", value: { intValue: 409 } },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            });
            arexTraces.set(traceId, {
              traceId,
              state: "ingested",
              serverEntry: {
                spanId: serverSpanId,
                serviceName: "demo-backend",
                method: "POST",
                routeOrPath: url.pathname,
                status: 409,
                durationMs: 8,
              },
              outboundHttp: [],
            });
          }
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "already an active workspace member" }));
          return;
        }

        const emailUrl = `${emailOrigin}/v1/account/invite/submit`;
        const outboundPayload = {
          subject: `You are invited to ${workspace}`,
          to: [{ address: email }],
          html: `<a href="${appOrigin}/invite/tok_live_secret_999">Accept</a>`,
        };
        const emailResponse = await fetch(emailUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer super_secret_email_api_key",
          },
          body: JSON.stringify(outboundPayload),
        });
        const emailResponseText = await emailResponse.text();

        const redactedRequestJson = JSON.stringify({
          ...outboundPayload,
          html: outboundPayload.html.replace(
            /\/invite\/[A-Za-z0-9_-]+/g,
            "/invite/[REDACTED]",
          ),
        });

        const clientSpanId = randomSpanHex();
        const bodyHelperSpanId = randomSpanHex();

        if (isTraceId(traceId)) {
          setTimeout(() => {
            blackboxTraces.set(traceId, {
              batches: [
                {
                  resource: {
                    attributes: [
                      { key: "service.name", value: { stringValue: "demo-backend" } },
                    ],
                  },
                  scopeSpans: [
                    {
                      spans: [
                        {
                          traceId,
                          spanId: serverSpanId,
                          parentSpanId: incomingSpanId,
                          name: `POST ${url.pathname}`,
                          kind: 2,
                          startTimeUnixNano: "1700000000000000000",
                          endTimeUnixNano: "1700000000025000000",
                          attributes: [
                            { key: "http.request.method", value: { stringValue: "POST" } },
                            { key: "url.path", value: { stringValue: url.pathname } },
                            { key: "http.response.status_code", value: { intValue: 200 } },
                          ],
                        },
                        {
                          traceId,
                          spanId: clientSpanId,
                          parentSpanId: serverSpanId,
                          name: "POST",
                          kind: 3,
                          startTimeUnixNano: "1700000000004000000",
                          endTimeUnixNano: "1700000000020000000",
                          attributes: [
                            { key: "http.request.method", value: { stringValue: "POST" } },
                            { key: "url.full", value: { stringValue: emailUrl } },
                            {
                              key: "http.response.status_code",
                              value: { intValue: emailResponse.status },
                            },
                          ],
                        },
                        {
                          traceId,
                          spanId: bodyHelperSpanId,
                          parentSpanId: clientSpanId,
                          name: "softprobe.http.body.capture",
                          kind: 1,
                          startTimeUnixNano: "1700000000005000000",
                          endTimeUnixNano: "1700000000019000000",
                          attributes: [
                            {
                              key: "sp.observation.type",
                              value: { stringValue: "http_body" },
                            },
                            {
                              key: "http.request.body.content",
                              value: { stringValue: `sp.json:${redactedRequestJson}` },
                            },
                            {
                              key: "http.response.body.content",
                              value: { stringValue: `sp.json:${emailResponseText}` },
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            });

            arexTraces.set(traceId, {
              traceId,
              state: "ingested",
              serverEntry: {
                spanId: serverSpanId,
                serviceName: "demo-backend",
                method: "POST",
                routeOrPath: url.pathname,
                status: 200,
                durationMs: 25,
              },
              outboundHttp: [
                {
                  traceId,
                  spanId: clientSpanId,
                  parentServerSpanId: serverSpanId,
                  serviceName: "demo-backend",
                  method: "POST",
                  url: emailUrl,
                  status: emailResponse.status,
                  durationMs: 16,
                  request: {
                    text: redactedRequestJson,
                    headers: { "content-type": "application/json" },
                  },
                  response: {
                    text: emailResponseText,
                    headers: { "content-type": "application/json" },
                  },
                },
              ],
            });
          }, 25);
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, traceId }));
        return;
      }

      res.writeHead(404);
      res.end();
    });
    const appBound = await listenEphemeral(appServer);
    appOrigin = appBound.origin;
  });

  afterAll(async () => {
    await Promise.all([
      closeServer(appServer),
      closeServer(blackboxServer),
      closeServer(arexServer),
      closeServer(emailServer),
    ]);
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    if (previousTelemetryEnv === undefined) {
      delete process.env.E2E_TELEMETRY_DISABLED;
    } else {
      process.env.E2E_TELEMETRY_DISABLED = previousTelemetryEnv;
    }
  });

  function createTempE2EProject(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "softprobe-e2e-suite-"));
    tempDirs.push(dir);
    symlinkSync(
      path.join(REPO_ROOT, "node_modules"),
      path.join(dir, "node_modules"),
      "dir",
    );
    mkdirSync(path.join(dir, "tests"), { recursive: true });
    return dir;
  }

  it(
    "preserves @softprobe/web-record traceparent, mints fallback headers, disambiguates follow-up GETs, enforces negative checks, and isolates workers=2",
    async () => {
      const projectDir = createTempE2EProject();
      const configPath = path.join(projectDir, "e2e.config.ts");

      writeFileSync(
        configPath,
        `import type { E2EConfig } from "e2e";
import { softprobeReporter, softprobeWeb } from "@softprobe/e2e";

export default {
  projectId: "softprobe-e2e-blackbox-integration",
  workers: 2,
  retries: 0,
  tests: "tests/**/*.e2e.ts",
  targets: [
    {
      name: "blackbox-web",
      engine: softprobeWeb({
        endpoint: ${JSON.stringify(blackboxOrigin)},
        softprobeApiKey: "bb_int_token",
        workspaceId: "ws_int_001",
        explorerUrl: "http://127.0.0.1:59999",
        pollTimeoutMs: 5000,
        pollIntervalMs: 50,
        settleMs: 80,
      }),
      app: {
        url: ${JSON.stringify(appOrigin)},
        identity: "demo-workspace-app",
      },
    },
  ],
  reporters: [softprobeReporter()],
} satisfies E2EConfig;
`,
        "utf8",
      );

      writeFileSync(
        path.join(projectDir, "tests/header-and-invite.e2e.ts"),
        `import { z } from "zod";
import {
  describe,
  expect,
  isTraceInstrumentationError,
  test,
} from "@softprobe/e2e";

const EmailSchema = z.object({
  subject: z.string(),
  to: z.array(z.object({ address: z.string().email() })).min(1),
  html: z.string(),
});

describe("traceparent correlation and BlackboxSink verification", () => {
  test("preserves @softprobe/web-record traceparent without double-stamping and mints when absent", async ({
    app,
    screen,
    trace,
  }) => {
    await app.open("/with-web-record");
    await screen.getByRole("button", "Send instrumented ping").tap();
    await expect(screen.getByRole("status")).toContainText("Recorded ");
    const statusText = await screen.getByRole("status").textContent();
    expect(statusText).toMatch(/^Recorded [0-9a-f]{32}$/);
    const sdkTraceId = (statusText ?? "").replace("Recorded ", "").trim();

    const sdkCall = await trace.outboundHttp({
      triggeredBy: { method: "POST", path: "/api/ping" },
      method: "POST",
      url: /\\/v1\\/account\\/invite\\/submit$/,
    });
    expect(sdkCall.traceId).toBe(sdkTraceId);
    expect(sdkCall.status).toBe(200);

    const mintedWindow = await trace.window(async () => {
      await app.open("/without-web-record");
      await screen.getByRole("button", "Send plain ping").tap();
      await expect(screen.getByRole("status")).toContainText("Minted ");
    });

    const mintedCall = await mintedWindow.outboundHttp({
      triggeredBy: { method: "POST", path: "/api/ping" },
      method: "POST",
      url: /\\/v1\\/account\\/invite\\/submit$/,
    });
    expect(mintedCall.traceId).not.toBe(sdkTraceId);
    const mintedStatus = await screen.getByRole("status").textContent();
    expect(mintedStatus).toBe(\`Minted \${mintedCall.traceId}\`);
  });

  test("resolves POST trigger amidst follow-up GET reloads, coalesces body capture, and scopes trace.window", async ({
    app,
    screen,
    trace,
  }) => {
    await app.open("/invite");
    await screen.getByLabel("Email address").fill("lc@softprobe.ai");
    await screen.getByRole("button", "Send invitation").tap();

    await expect(screen.getByRole("status")).toContainText(
      "Invitation email sent to lc@softprobe.ai.",
    );
    await expect(screen.getByText("lc@softprobe.ai")).toBeVisible();
    await expect(screen.getByRole("button", "Revoke")).toBeVisible();

    const emailCall = await trace.outboundHttp({
      triggeredBy: {
        method: "POST",
        path: "/api/workspaces/:workspaceId/invites",
      },
      method: "POST",
      url: /\\/v1\\/account\\/[^/]+\\/submit$/,
      status: [200, 299],
    });

    const parsedBody = expect(emailCall.request.json).toMatchSchema(EmailSchema);
    expect(parsedBody.to.map((r) => r.address)).toContain("lc@softprobe.ai");
    expect(parsedBody.subject).toContain("Alpha Workspace");
    expect(parsedBody.html).toContain("/invite/[REDACTED]");
    expect(parsedBody.html).not.toContain("tok_live_secret_999");

    const resendScope = await trace.window(async () => {
      await screen.getByLabel("Email address").fill("second@softprobe.ai");
      await screen.getByRole("button", "Resend").tap();
      await expect(screen.getByRole("status")).toContainText(
        "A new invitation email was sent to second@softprobe.ai.",
      );
    });

    const resentCall = await resendScope.outboundHttp({
      triggeredBy: {
        method: "POST",
        path: "/api/workspaces/:workspaceId/invites",
      },
      url: /\\/v1\\/account\\/[^/]+\\/submit$/,
    });
    expect(resentCall.traceId).not.toBe(emailCall.traceId);
    const resentBody = expect(resentCall.request.json).toMatchSchema(EmailSchema);
    expect(resentBody.to[0]?.address).toBe("second@softprobe.ai");
  });

  test("enforces negative-check soundness on awaiting_server_span vs 409 ingested", async ({
    app,
    screen,
    trace,
  }) => {
    await app.open("/uninstrumented");
    await screen.getByRole("button", "Fire uninstrumented call").tap();
    await expect(screen.getByRole("status")).toContainText("Done");

    let caughtError: unknown;
    try {
      await trace.expectNoOutboundHttp({
        triggeredBy: {
          method: "POST",
          path: "/api/workspaces/:workspaceId/uninstrumented",
        },
        url: /submit/,
        pollTimeoutMs: 450,
        pollIntervalMs: 80,
      });
    } catch (error) {
      caughtError = error;
    }

    expect(isTraceInstrumentationError(caughtError)).toBe(true);
    if (isTraceInstrumentationError(caughtError)) {
      expect(caughtError.explorerTraceUrl).toContain("http://127.0.0.1:59999/?trace=");
    }

    await app.open("/invite");
    await screen.getByLabel("Email address").fill("owner@softprobe.ai");
    await screen.getByRole("button", "Send invitation").tap();
    await expect(screen.getByRole("status")).toContainText(
      "owner@softprobe.ai is already an active workspace member.",
    );

    await trace.expectNoOutboundHttp({
      triggeredBy: {
        method: "POST",
        path: "/api/workspaces/:workspaceId/invites",
      },
      url: /submit/,
    });
  });
});
`,
        "utf8",
      );

      writeFileSync(
        path.join(projectDir, "tests/parallel-worker-a.e2e.ts"),
        `import { z } from "zod";
import { expect, test } from "@softprobe/e2e";

const PayloadSchema = z.object({
  to: z.array(z.object({ address: z.string() })),
});

test("worker A isolates its own TraceId under concurrent load", async ({
  app,
  screen,
  trace,
}) => {
  await app.open("/invite");
  await screen.getByLabel("Email address").fill("worker-a@softprobe.ai");
  await screen.getByRole("button", "Send invitation").tap();
  await expect(screen.getByRole("status")).toContainText(
    "Invitation email sent to worker-a@softprobe.ai.",
  );

  const call = await trace.outboundHttp({
    triggeredBy: { method: "POST", path: "/api/workspaces/:workspaceId/invites" },
    url: /\\/v1\\/account\\/invite\\/submit$/,
  });
  const body = expect(call.request.json).toMatchSchema(PayloadSchema);
  expect(body.to[0]?.address).toBe("worker-a@softprobe.ai");
});
`,
        "utf8",
      );

      writeFileSync(
        path.join(projectDir, "tests/parallel-worker-b.e2e.ts"),
        `import { z } from "zod";
import { expect, test } from "@softprobe/e2e";

const PayloadSchema = z.object({
  to: z.array(z.object({ address: z.string() })),
});

test("worker B isolates its own TraceId under concurrent load", async ({
  app,
  screen,
  trace,
}) => {
  await app.open("/invite");
  await screen.getByLabel("Email address").fill("worker-b@softprobe.ai");
  await screen.getByRole("button", "Send invitation").tap();
  await expect(screen.getByRole("status")).toContainText(
    "Invitation email sent to worker-b@softprobe.ai.",
  );

  const call = await trace.outboundHttp({
    triggeredBy: { method: "POST", path: "/api/workspaces/:workspaceId/invites" },
    url: /\\/v1\\/account\\/invite\\/submit$/,
  });
  const body = expect(call.request.json).toMatchSchema(PayloadSchema);
  expect(body.to[0]?.address).toBe("worker-b@softprobe.ai");
});
`,
        "utf8",
      );

      const outcome = await runE2ESuite({
        cwd: projectDir,
        config: configPath,
      });

      expect(outcome.status).toBe("passed");
      expect(outcome.exitCode).toBe(0);
      expect(outcome.report.run.summary.passed).toBe(5);
      expect(outcome.report.run.summary.failed).toBe(0);

      const pingHits = apiHits.filter((hit) => hit.pathname === "/api/ping");
      expect(pingHits.length).toBe(2);
      for (const hit of pingHits) {
        expect(hit.traceparentHeaders).toHaveLength(1);
        expect(hit.traceparentHeaders[0]).not.toContain(",");
      }

      const tracesReportPath = path.join(projectDir, ".e2e/softprobe-traces.json");
      expect(existsSync(tracesReportPath)).toBe(true);
      const tracesReport = softprobeTracesReportSchema.parse(
        JSON.parse(readFileSync(tracesReportPath, "utf8")),
      );
      expect(tracesReport.traces.length).toBe(7);

      const headerSources = new Set(
        tracesReport.traces.map((entry) => entry.triggeredBy.headerSource),
      );
      expect(headerSources.has("preserved")).toBe(true);
      expect(headerSources.has("minted")).toBe(true);

      const workerTraceIds = new Set(tracesReport.traces.map((t) => t.traceId));
      expect(workerTraceIds.size).toBe(7);

      mkdirSync(EVIDENCE_DIR, { recursive: true });
      if (outcome.reportPath && existsSync(outcome.reportPath)) {
        copyFileSync(
          outcome.reportPath,
          path.join(EVIDENCE_DIR, "blackbox-e2e-report.json"),
        );
      }
      copyFileSync(
        tracesReportPath,
        path.join(EVIDENCE_DIR, "softprobe-traces.json"),
      );
    },
    90_000,
  );

  it(
    "records agent.act into .e2e/cache/ on Run 1 and replays with zero model calls on Run 2 while verifying a fresh ArexSink TraceId",
    async () => {
      const projectDir = createTempE2EProject();
      const configPath = path.join(projectDir, "e2e.config.ts");
      const markerPath = path.join(projectDir, "executor-calls.log");

      const buildConfigSource = (forbidExecutorCalls: boolean) => `import { appendFileSync } from "node:fs";
import type { E2EConfig, ExecutorNode, StepExecutor } from "e2e";
import { softprobeReporter, softprobeWeb } from "@softprobe/e2e";

function findNode(
  node: ExecutorNode | undefined,
  role: string,
  name: string,
): ExecutorNode | undefined {
  if (!node) return undefined;
  if (node.role === role && node.name === name) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, role, name);
    if (found) return found;
  }
  return undefined;
}

const executor: StepExecutor = {
  name: "deterministic-invite-executor",
  version: "1.0.0",
  async runStep(ctx) {
    appendFileSync(${JSON.stringify(markerPath)}, "called\\n", "utf8");
    if (${String(forbidExecutorCalls)}) {
      throw new Error("unexpected model call on cached Run 2");
    }
    ctx.budgets.recordModelCall({
      provider: "deterministic",
      modelId: "invite-v1",
      inputTokens: 16,
      outputTokens: 8,
    });

    const firstLook = await ctx.observe({ tree: true });
    const emailInput = findNode(firstLook.tree, "textbox", "Email address");
    if (!emailInput) {
      return { status: "failed", summary: "Email input missing" };
    }
    const targetEmail =
      typeof ctx.step.params?.email === "string"
        ? ctx.step.params.email
        : "lc@softprobe.ai";
    await ctx.actions.type({ id: emailInput.id }, targetEmail);

    const secondLook = await ctx.observe({ tree: true });
    const submitBtn = findNode(secondLook.tree, "button", "Send invitation");
    if (!submitBtn) {
      return { status: "failed", summary: "Send invitation button missing" };
    }
    await ctx.actions.tap({ id: submitBtn.id });

    for (let i = 0; i < 20; i += 1) {
      const settled = await ctx.observe();
      if (settled.text.includes("Invitation email sent to")) {
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }

    return {
      status: "passed",
      summary: \`Invited \${targetEmail}\`,
    };
  },
};

export default {
  projectId: "softprobe-e2e-cache-replay",
  workers: 1,
  retries: 0,
  cache: {
    mode: "read-write",
  },
  agents: {
    default: {
      executor,
    },
  },
  tests: "tests/**/*.e2e.ts",
  targets: [
    {
      name: "arex-web",
      engine: softprobeWeb({
        sink: {
          kind: "arex",
          endpoint: ${JSON.stringify(arexOrigin)},
          appId: "demo-app",
          softprobeApiKey: "arex_int_token",
          tenantId: "tenant_int_1",
        },
        pollTimeoutMs: 5000,
        pollIntervalMs: 50,
      }),
      app: {
        url: ${JSON.stringify(appOrigin)},
        identity: "demo-arex-app",
      },
    },
  ],
  reporters: [softprobeReporter()],
} satisfies E2EConfig;
`;

      writeFileSync(
        path.join(projectDir, "tests/cached-invite.e2e.ts"),
        `import { z } from "zod";
import { expect, test } from "@softprobe/e2e";

const OutboundEmailSchema = z.object({
  subject: z.string(),
  to: z.array(z.object({ address: z.string().email() })).min(1),
  html: z.string(),
});

test("invites lc@softprobe.ai via agent.act and verifies ArexSink trace", async ({
  app,
  agent,
  screen,
  trace,
}) => {
  await app.open("/invite");

  const actResult = await agent.act(
    "enter {email} in Email address and click Send invitation",
    { params: { email: "lc@softprobe.ai" } },
  );

  await expect(screen.getByRole("status")).toContainText(
    "Invitation email sent to lc@softprobe.ai.",
  );
  await expect(screen.getByRole("button", "Revoke")).toBeVisible();

  const emailCall = await trace.outboundHttp({
    triggeredBy: {
      method: "POST",
      path: "/api/workspaces/:workspaceId/invites",
    },
    method: "POST",
    url: /\\/v1\\/account\\/invite\\/submit$/,
  });

  expect(emailCall.status).toBe(200);
  const body = expect(emailCall.request.json).toMatchSchema(OutboundEmailSchema);
  expect(body.to[0]?.address).toBe("lc@softprobe.ai");
  expect(body.html).toContain("/invite/[REDACTED]");
  expect(actResult.actions).toBeGreaterThanOrEqual(2);
});
`,
        "utf8",
      );

      writeFileSync(configPath, buildConfigSource(false), "utf8");
      const run1 = await runE2ESuite({
        cwd: projectDir,
        config: configPath,
      });
      expect(run1.status).toBe("passed");
      expect(run1.exitCode).toBe(0);

      const cacheDir = path.join(projectDir, ".e2e/cache");
      expect(existsSync(cacheDir)).toBe(true);
      expect(readdirSync(cacheDir).length).toBeGreaterThan(0);

      const run1Calls = existsSync(markerPath)
        ? readFileSync(markerPath, "utf8").trim().split("\n").filter(Boolean).length
        : 0;
      expect(run1Calls).toBe(1);

      const run1Traces = softprobeTracesReportSchema.parse(
        JSON.parse(
          readFileSync(path.join(projectDir, ".e2e/softprobe-traces.json"), "utf8"),
        ),
      );
      const run1TraceId = run1Traces.traces[0]?.traceId;
      expect(isTraceId(run1TraceId)).toBe(true);

      writeFileSync(configPath, buildConfigSource(true), "utf8");
      const run2 = await runE2ESuite({
        cwd: projectDir,
        config: configPath,
      });
      expect(run2.status).toBe("passed");
      expect(run2.exitCode).toBe(0);
      expect(run2.report.run.usage.modelTokens).toBe(0);
      expect(run2.report.run.usage.maxModelCallsInStep).toBe(0);

      const afterRun2Calls = readFileSync(markerPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean).length;
      expect(afterRun2Calls).toBe(1);

      const run2Traces = softprobeTracesReportSchema.parse(
        JSON.parse(
          readFileSync(path.join(projectDir, ".e2e/softprobe-traces.json"), "utf8"),
        ),
      );
      const run2TraceId = run2Traces.traces[0]?.traceId;
      expect(isTraceId(run2TraceId)).toBe(true);
      expect(run2TraceId).not.toBe(run1TraceId);

      mkdirSync(EVIDENCE_DIR, { recursive: true });
      if (run2.reportPath && existsSync(run2.reportPath)) {
        copyFileSync(
          run2.reportPath,
          path.join(EVIDENCE_DIR, "arex-cache-run2-report.json"),
        );
      }
      if (run2TraceId) {
        writeFileSync(
          path.join(EVIDENCE_DIR, "outbound-trace.json"),
          JSON.stringify(arexTraces.get(run2TraceId), null, 2),
          "utf8",
        );
      }
    },
    90_000,
  );
});
