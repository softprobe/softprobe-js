import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
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
import { promisify } from "node:util";
import { chromium } from "@playwright/test";
import { run as runE2ESuite } from "e2e/runner";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isTraceId } from "../../src/index.js";
import { z } from "zod";
import {
  compileSessionToE2E,
  compileSessionToPlaywright,
  extractSessionBundleFromSpans,
  fetchSessionSpansFromBlackbox,
} from "../../src/session-compiler.js";

const execFileAsync = promisify(execFile);

const PACKAGE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const REPO_ROOT = path.resolve(PACKAGE_DIR, "../..");
const WEB_RECORD_BUNDLE_PATH = path.join(
  REPO_ROOT,
  "packages/web-record/dist/browser.js",
);
const PLAYWRIGHT_CLI_PATH = path.join(
  REPO_ROOT,
  "node_modules/@playwright/test/cli.js",
);
const TSC_CLI_PATH = path.join(
  REPO_ROOT,
  "node_modules/typescript/bin/tsc",
);
const OTLP_ROOT_MODULE_PATH = path.join(
  REPO_ROOT,
  "node_modules/@opentelemetry/otlp-transformer/build/esm/generated/root.js",
);

interface SentEmailRecord {
  readonly to: string;
  readonly subject: string;
}

function readRawBuffer(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
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

function decodeBase64OrHexToHex(raw: unknown, expectedBytes: 16 | 8): string {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (trimmed.length === expectedBytes * 2 && /^[0-9a-fA-F]+$/.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  try {
    const decoded = Buffer.from(trimmed, "base64");
    if (decoded.length === expectedBytes) {
      return decoded.toString("hex").toLowerCase();
    }
  } catch {}
  return "";
}

describe("Session compiler real-runtime Chromium + Playwright + zero-LLM e2e replay", () => {
  const previousTelemetryEnv = process.env.E2E_TELEMETRY_DISABLED;
  let emailServer: Server | undefined;
  let blackboxServer: Server | undefined;
  let appServer: Server | undefined;

  let emailOrigin = "";
  let blackboxOrigin = "";
  let appOrigin = "";

  const sentEmails: SentEmailRecord[] = [];
  const ingestedResourceSpans: unknown[] = [];
  const backendTraceBatches = new Map<string, unknown[]>();
  const tempDirs: string[] = [];

  beforeAll(async () => {
    process.env.E2E_TELEMETRY_DISABLED = "1";
    const otlpRootMod = (await import(OTLP_ROOT_MODULE_PATH)) as {
      default: {
        opentelemetry: {
          proto: {
            collector: {
              trace: {
                v1: {
                  ExportTraceServiceRequest: {
                    decode(bytes: Uint8Array): unknown;
                    toObject(
                      msg: unknown,
                      opts: { longs: StringConstructor; bytes: StringConstructor },
                    ): { resourceSpans?: unknown[] };
                  };
                };
              };
            };
          };
        };
      };
    };
    const ExportTraceServiceRequest =
      otlpRootMod.default.opentelemetry.proto.collector.trace.v1
        .ExportTraceServiceRequest;

    emailServer = createServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/v1/email/send") {
        const raw = (await readRawBuffer(req)).toString("utf8");
        const parsed = JSON.parse(raw) as { to: string; subject: string };
        sentEmails.push({ to: parsed.to, subject: parsed.subject });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            messageId: `email_${sentEmails.length}`,
            delivered: true,
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
    emailOrigin = (await listenEphemeral(emailServer)).origin;

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
        const buf = await readRawBuffer(req);
        const contentType = (req.headers["content-type"] ?? "").toLowerCase();
        if (contentType.includes("protobuf")) {
          const decoded = ExportTraceServiceRequest.decode(new Uint8Array(buf));
          const obj = ExportTraceServiceRequest.toObject(decoded, {
            longs: String,
            bytes: String,
          });
          for (const rs of obj.resourceSpans ?? []) {
            ingestedResourceSpans.push(rs);
          }
        } else {
          const parsed = JSON.parse(buf.toString("utf8")) as {
            resourceSpans?: unknown[];
          };
          for (const rs of parsed.resourceSpans ?? []) {
            ingestedResourceSpans.push(rs);
          }
        }
        res.writeHead(200, {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": "application/json",
        });
        res.end("{}");
        return;
      }

      const sessionMatch = /^\/v1\/llm\/sessions\/([^/]+)\/spans$/.exec(url.pathname);
      if (req.method === "GET" && sessionMatch) {
        const requestedSessionId = decodeURIComponent(sessionMatch[1]!);
        const flatSpans: unknown[] = [];
        for (const rs of ingestedResourceSpans as Array<{
          resource?: { attributes?: unknown[] };
          scopeSpans?: Array<{ spans?: Array<Record<string, unknown>> }>;
        }>) {
          for (const scope of rs.scopeSpans ?? []) {
            for (const sp of scope.spans ?? []) {
              const attrs = Array.isArray(sp.attributes) ? sp.attributes : [];
              const matchesSession = attrs.some(
                (kv: unknown) =>
                  typeof kv === "object" &&
                  kv !== null &&
                  ((kv as { key?: string }).key === "sp.session.id" ||
                    (kv as { key?: string }).key === "session.id") &&
                  (kv as { value?: { stringValue?: string } }).value?.stringValue ===
                    requestedSessionId,
              );
              if (matchesSession) {
                flatSpans.push({
                  ...sp,
                  traceId: decodeBase64OrHexToHex(sp.traceId, 16),
                  spanId: decodeBase64OrHexToHex(sp.spanId, 8),
                  parentSpanId: decodeBase64OrHexToHex(sp.parentSpanId, 8) || undefined,
                  session_id: requestedSessionId,
                });
              }
            }
          }
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ session_id: requestedSessionId, spans: flatSpans }));
        return;
      }

      const traceMatch = /^\/api\/traces\/([0-9a-f]{32})$/.exec(url.pathname);
      if (req.method === "GET" && traceMatch) {
        if (req.headers.authorization !== "Bearer bb_live_token") {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "unauthorized" }));
          return;
        }
        if (req.headers["x-workspace-id"] !== "ws_live_001") {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "forbidden workspace" }));
          return;
        }
        const traceId = traceMatch[1]!;
        const backendBatches = backendTraceBatches.get(traceId);
        if (!backendBatches) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "not found" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ batches: backendBatches }));
        return;
      }

      res.writeHead(404);
      res.end();
    });
    blackboxOrigin = (await listenEphemeral(blackboxServer)).origin;

    const webRecordBundle = readFileSync(WEB_RECORD_BUNDLE_PATH, "utf8");

    appServer = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");

      if (req.method === "GET" && url.pathname === "/sdk/web-record.js") {
        res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
        res.end(webRecordBundle);
        return;
      }

      if (req.method === "GET" && url.pathname === "/onboarding") {
        const recordFlag = req.headers["x-enable-web-record"] === "1";
        const sdkOpts = JSON.stringify({
          ingestionKey: "sp_live_ingest_key",
          serviceName: "onboarding-web",
          sessionId: "sess_live_chromium_001",
          captureSemanticActions: true,
          inputCapture: "secrets-only",
          otlp: { tracesEndpoint: `${blackboxOrigin}/v1/traces` },
        });
        const scriptTag = recordFlag
          ? `<script src="/sdk/web-record.js" data-softprobe-options='${sdkOpts}'></script>`
          : "";

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Member Onboarding</title>
    ${scriptTag}
  </head>
  <body>
    <h1>Member Onboarding</h1>
    <form id="onboard-form">
      <label for="member-email">Work email</label>
      <input id="member-email" name="email" type="email" placeholder="teammate@company.com" />
      <label for="member-password">Account password</label>
      <input id="member-password" name="password" type="password" />
      <button id="provision-btn" type="button">Provision account</button>
    </form>
    <div role="status" id="provision-status">Awaiting input</div>
    <script>
      document.getElementById("provision-btn").addEventListener("click", async () => {
        const email = document.getElementById("member-email").value.trim();
        const password = document.getElementById("member-password").value;
        if (!email || password !== "Sup3rS3cretPass!") {
          document.getElementById("provision-status").textContent = "Invalid credentials";
          return;
        }
        const resp = await fetch("/api/accounts/provision", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        });
        if (resp.ok) {
          document.getElementById("provision-status").textContent =
            "Account provisioned for " + email;
        }
      });
    </script>
  </body>
</html>`);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/accounts/provision") {
        const rawText = (await readRawBuffer(req)).toString("utf8");
        const body = JSON.parse(rawText) as { email: string; password: string };
        const tp = String(req.headers["traceparent"] ?? "");
        const tpParts = tp.split("-");
        const traceId = tpParts[1] ?? "";
        const parentSpanId = tpParts[2] ?? randomSpanHex();

        const emailUrl = `${emailOrigin}/v1/email/send`;
        const emailPayload = {
          to: body.email,
          subject: "Welcome to Softprobe Engineering",
        };
        const emailResp = await fetch(emailUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(emailPayload),
        });
        const emailRespText = await emailResp.text();

        if (isTraceId(traceId)) {
          const serverSpanId = randomSpanHex();
          const clientSpanId = randomSpanHex();
          backendTraceBatches.set(traceId, [
            {
              resource: {
                attributes: [
                  { key: "service.name", value: { stringValue: "onboarding-backend" } },
                ],
              },
              scopeSpans: [
                {
                  spans: [
                    {
                      traceId,
                      spanId: serverSpanId,
                      parentSpanId,
                      name: "POST /api/accounts/provision",
                      kind: 2,
                      startTimeUnixNano: "1700000000000000000",
                      endTimeUnixNano: "1700000000020000000",
                      attributes: [
                        { key: "http.request.method", value: { stringValue: "POST" } },
                        { key: "url.path", value: { stringValue: "/api/accounts/provision" } },
                        { key: "http.response.status_code", value: { intValue: 200 } },
                      ],
                    },
                    {
                      traceId,
                      spanId: clientSpanId,
                      parentSpanId: serverSpanId,
                      name: "POST",
                      kind: 3,
                      startTimeUnixNano: "1700000000003000000",
                      endTimeUnixNano: "1700000000018000000",
                      attributes: [
                        { key: "http.request.method", value: { stringValue: "POST" } },
                        { key: "url.full", value: { stringValue: emailUrl } },
                        { key: "http.response.status_code", value: { intValue: emailResp.status } },
                        {
                          key: "http.request.body.content",
                          value: { stringValue: `sp.json:${JSON.stringify(emailPayload)}` },
                        },
                        {
                          key: "http.response.body.content",
                          value: { stringValue: `sp.json:${emailRespText}` },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ]);
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, traceId }));
        return;
      }

      if (req.method === "GET" && url.pathname === "/ota/index.html") {
        const recordFlag = req.headers["x-enable-web-record"] === "1";
        const sdkOpts = JSON.stringify({
          ingestionKey: "sp_live_ingest_key",
          serviceName: "ota-web",
          sessionId: "sess_live_unlabeled_twins_001",
          captureSemanticActions: true,
          inputCapture: "secrets-only",
          otlp: { tracesEndpoint: `${blackboxOrigin}/v1/traces` },
        });
        const scriptTag = recordFlag
          ? `<script src="/sdk/web-record.js" data-softprobe-options='${sdkOpts}'></script>`
          : "";
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Travel OTA</title>
    <style>.icon-search::before { content: "\\f002"; }</style>
    ${scriptTag}
  </head>
  <body>
    <form id="searchForm">
      <div><label>From</label><select id="fromCity"><option value="JFK">New York (JFK)</option><option value="LHR">London Heathrow (LHR)</option></select></div>
      <div><label>To</label><select id="toCity"><option value="SFO">San Francisco (SFO)</option><option value="CDG">Paris Charles de Gaulle (CDG)</option></select></div>
      <div><label>Departure</label><input id="departureDate" type="text" /></div>
      <div><button id="searchBtn" type="button"><i class="icon-search"></i> Search</button></div>
    </form>
    <script>
      document.getElementById("searchBtn").addEventListener("click", async () => {
        const origin = document.getElementById("fromCity").value;
        const destination = document.getElementById("toCity").value;
        const dep = document.getElementById("departureDate").value;
        const resp = await fetch("/api/flights/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ origin, destination, dep }),
        });
        if (resp.ok) {
          await window.__softprobeSession?.flush?.();
          window.location.href = "/ota/list.html?from=" + encodeURIComponent(origin) + "&to=" + encodeURIComponent(destination);
        }
      });
    </script>
  </body>
</html>`);
        return;
      }

      if (req.method === "GET" && url.pathname === "/ota/list.html") {
        const recordFlag = req.headers["x-enable-web-record"] === "1";
        const sdkOpts = JSON.stringify({
          ingestionKey: "sp_live_ingest_key",
          serviceName: "ota-web",
          sessionId: "sess_live_unlabeled_twins_001",
          captureSemanticActions: true,
          inputCapture: "secrets-only",
          otlp: { tracesEndpoint: `${blackboxOrigin}/v1/traces` },
        });
        const scriptTag = recordFlag
          ? `<script src="/sdk/web-record.js" data-softprobe-options='${sdkOpts}'></script>`
          : "";
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><html><head><meta charset="utf-8" />${scriptTag}</head><body><h1>Available Flights</h1></body></html>`);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/flights/search") {
        const rawText = (await readRawBuffer(req)).toString("utf8");
        const body = z
          .object({ origin: z.string(), destination: z.string(), dep: z.string() })
          .parse(JSON.parse(rawText));
        const tp = String(req.headers["traceparent"] ?? "");
        const tpParts = tp.split("-");
        const traceId = tpParts[1] ?? "";
        const parentSpanId = tpParts[2] ?? randomSpanHex();
        const emailUrl = `${emailOrigin}/v1/email/send`;
        const ndcResp = await fetch(emailUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ to: `${body.origin}-${body.destination}@ndc.local`, subject: body.dep }),
        });
        if (isTraceId(traceId)) {
          const serverSpanId = randomSpanHex();
          const clientSpanId = randomSpanHex();
          backendTraceBatches.set(traceId, [
            {
              resource: {
                attributes: [{ key: "service.name", value: { stringValue: "travel-ota" } }],
              },
              scopeSpans: [
                {
                  spans: [
                    {
                      traceId,
                      spanId: serverSpanId,
                      parentSpanId,
                      name: "POST /api/flights/search",
                      kind: 2,
                      startTimeUnixNano: "1700000000000000000",
                      endTimeUnixNano: "1700000000020000000",
                      attributes: [
                        { key: "http.request.method", value: { stringValue: "POST" } },
                        { key: "url.path", value: { stringValue: "/api/flights/search" } },
                        { key: "http.response.status_code", value: { intValue: 200 } },
                      ],
                    },
                    {
                      traceId,
                      spanId: clientSpanId,
                      parentSpanId: serverSpanId,
                      name: "POST",
                      kind: 3,
                      startTimeUnixNano: "1700000000003000000",
                      endTimeUnixNano: "1700000000018000000",
                      attributes: [
                        { key: "http.request.method", value: { stringValue: "POST" } },
                        { key: "url.full", value: { stringValue: emailUrl } },
                        { key: "http.response.status_code", value: { intValue: ndcResp.status } },
                      ],
                    },
                  ],
                },
              ],
            },
          ]);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      res.writeHead(404);
      res.end();
    });
    appOrigin = (await listenEphemeral(appServer)).origin;
  });

  afterAll(async () => {
    await Promise.all([
      closeServer(appServer),
      closeServer(blackboxServer),
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

  function createTempProject(prefix: string): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
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
    "captures live semantic actions in Chromium via @softprobe/web-record, then compiles and passes both @playwright/test and zero-LLM e2e run with causal outboundHttp verification",
    async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage({
          viewport: { width: 1280, height: 720 },
          extraHTTPHeaders: { "x-enable-web-record": "1" },
        });
        await page.goto(`${appOrigin}/onboarding`);
        await page.getByLabel("Work email").fill("newhire@softprobe.ai");
        await page.getByLabel("Account password").fill("Sup3rS3cretPass!");
        await page.getByRole("button", { name: "Provision account" }).click();
        await expect
          .poll(async () => page.getByRole("status").textContent())
          .toBe("Account provisioned for newhire@softprobe.ai");

        const flushed = await page.evaluate(async () => {
          const w = window as unknown as {
            __softprobeSession?: { flush: () => Promise<boolean> };
          };
          return (await w.__softprobeSession?.flush()) ?? false;
        });
        expect(flushed).toBe(true);
      } finally {
        await browser.close();
      }

      expect(sentEmails).toHaveLength(1);
      expect(JSON.stringify(ingestedResourceSpans)).not.toContain("Sup3rS3cretPass!");

      const fetched = await fetchSessionSpansFromBlackbox({
        endpoint: blackboxOrigin,
        sessionId: "sess_live_chromium_001",
        token: "bb_live_token",
        workspaceId: "ws_live_001",
      });

      const normalizedBundle = extractSessionBundleFromSpans(
        {
          sessionId: fetched.sessionId,
          spans: fetched.spans,
        },
        {
          sessionId: "sess_live_chromium_001",
          baseOrigin: appOrigin,
          tracesByTraceId: fetched.tracesByTraceId,
        },
      );

      expect(normalizedBundle.steps.map((s) => s.action.verb.name)).toEqual([
        "fill",
        "fill",
        "click",
      ]);
      expect(normalizedBundle.secretSlots).toEqual(["PASSWORD"]);
      expect(normalizedBundle.outboundAssertionCount).toBe(1);

      const pwProjectDir = createTempProject("sp-compiled-playwright-");
      const pwSuite = compileSessionToPlaywright(normalizedBundle, {
        targetUrl: appOrigin,
        sinkEndpoint: blackboxOrigin,
        workspaceId: "ws_live_001",
      });
      for (const file of pwSuite.files) {
        const targetPath = path.join(pwProjectDir, file.relativePath);
        mkdirSync(path.dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, file.content, "utf8");
      }
      writeFileSync(
        path.join(pwProjectDir, "tests/fixture-adaptation.spec.ts"),
        [
          `import { expect, test } from "@softprobe/e2e/playwright";`,
          `import type { TraceScope } from "@softprobe/e2e";`,
          ``,
          `function fallbackScope(_a: number, _b: number): TraceScope {`,
          `  throw new Error("fallbackScope should not run when Playwright injects trace");`,
          `}`,
          ``,
          `test("injects trace with nested call defaults and inline comments", async ({`,
          `  page /* a:b */,`,
          `  baseURL = "http://127.0.0.1:1/a)b,c",`,
          `  trace /* inline */ = fallbackScope(1, 2),`,
          `}) => {`,
          `  expect(typeof page.goto).toBe("function");`,
          `  expect(typeof baseURL).toBe("string");`,
          `  expect(typeof trace.outboundHttp).toBe("function");`,
          `});`,
          ``,
          `test("injects trace under destructured property alias", async ({`,
          `  page,`,
          `  trace: customTrace,`,
          `}) => {`,
          `  expect(typeof page.goto).toBe("function");`,
          `  expect(typeof customTrace.outboundHttp).toBe("function");`,
          `});`,
          ``,
        ].join("\n"),
        "utf8",
      );
      writeFileSync(
        path.join(pwProjectDir, "tsconfig.json"),
        JSON.stringify(
          {
            compilerOptions: {
              target: "ES2022",
              module: "NodeNext",
              moduleResolution: "NodeNext",
              strict: true,
              noEmit: true,
              skipLibCheck: true,
              types: ["node"],
            },
            include: ["playwright.config.ts", "tests/**/*.ts"],
          },
          null,
          2,
        ),
        "utf8",
      );
      await execFileAsync(process.execPath, [
        TSC_CLI_PATH,
        "--noEmit",
        "-p",
        path.join(pwProjectDir, "tsconfig.json"),
      ]);

      const emailsBeforePw = sentEmails.length;
      const pwChildEnv: Record<string, string | undefined> = {
        ...process.env,
        APP_URL: appOrigin,
        SOFTPROBE_SINK_ENDPOINT: blackboxOrigin,
        SOFTPROBE_API_KEY: "bb_live_token",
        SOFTPROBE_WORKSPACE_ID: "ws_live_001",
        SP_SECRET_PASSWORD: "Sup3rS3cretPass!",
      };
      for (const k of Object.keys(pwChildEnv)) {
        if (k.startsWith("VITEST") || k.startsWith("TEST_")) {
          delete pwChildEnv[k];
        }
      }
      let pwStdout = "";
      let pwStderr = "";
      try {
        const pwRun = await execFileAsync(
          process.execPath,
          [PLAYWRIGHT_CLI_PATH, "test", "--config", "playwright.config.ts"],
          {
            cwd: pwProjectDir,
            env: pwChildEnv as NodeJS.ProcessEnv,
          },
        );
        pwStdout = pwRun.stdout;
        pwStderr = pwRun.stderr;
      } catch (err) {
        const execErr = err as { stdout?: string; stderr?: string; message?: string };
        throw new Error(
          `Playwright CLI failed: ${execErr.message ?? ""}\nSTDOUT:\n${execErr.stdout ?? ""}\nSTDERR:\n${execErr.stderr ?? ""}`,
        );
      }
      expect(pwStdout + pwStderr).toContain("3 passed");
      expect(sentEmails.length).toBe(emailsBeforePw + 1);

      const e2eProjectDir = createTempProject("sp-compiled-e2e-");
      const e2eSuite = compileSessionToE2E(normalizedBundle, {
        projectId: "sp-compiled-onboarding-e2e",
        appIdentity: "onboarding-web-app",
        targetUrl: appOrigin,
        sinkEndpoint: blackboxOrigin,
        workspaceId: "ws_live_001",
      });
      for (const file of [...e2eSuite.files, ...e2eSuite.cacheFiles]) {
        const targetPath = path.join(e2eProjectDir, file.relativePath);
        mkdirSync(path.dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, file.content, "utf8");
      }
      expect(e2eSuite.cacheFiles).toHaveLength(1);

      const scopedEnvOverrides: Record<string, string | undefined> = {
        E2E_TELEMETRY_DISABLED: "1",
        APP_URL: appOrigin,
        SOFTPROBE_SINK_ENDPOINT: blackboxOrigin,
        SOFTPROBE_API_KEY: "bb_live_token",
        SOFTPROBE_WORKSPACE_ID: "ws_live_001",
        SP_SECRET_PASSWORD: "Sup3rS3cretPass!",
        OPENAI_API_KEY: undefined,
        ANTHROPIC_API_KEY: undefined,
        AI_GATEWAY_API_KEY: undefined,
        OPENROUTER_API_KEY: undefined,
        GEMINI_API_KEY: undefined,
        GOOGLE_GENERATIVE_AI_API_KEY: undefined,
      };
      const savedEnv = new Map<string, string | undefined>();
      for (const [k, v] of Object.entries(scopedEnvOverrides)) {
        savedEnv.set(k, process.env[k]);
        if (v === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = v;
        }
      }

      const emailsBeforeE2E = sentEmails.length;
      let e2eOutcome: Awaited<ReturnType<typeof runE2ESuite>>;
      try {
        e2eOutcome = await runE2ESuite({
          cwd: e2eProjectDir,
          config: path.join(e2eProjectDir, "e2e.config.ts"),
        });
      } finally {
        for (const [k, prev] of savedEnv.entries()) {
          if (prev === undefined) {
            delete process.env[k];
          } else {
            process.env[k] = prev;
          }
        }
      }

      if (e2eOutcome.exitCode !== 0) {
        throw new Error(
          `e2e run exited with ${e2eOutcome.exitCode}:\n${JSON.stringify(e2eOutcome.report, null, 2)}`,
        );
      }
      expect(e2eOutcome.status).toBe("passed");
      expect(e2eOutcome.exitCode).toBe(0);
      expect(e2eOutcome.report.run.summary.passed).toBe(1);
      expect(e2eOutcome.report.run.summary.failed).toBe(0);
      expect(e2eOutcome.report.run.usage.modelTokens).toBe(0);
      expect(e2eOutcome.report.run.usage.maxModelCallsInStep).toBe(0);
      expect(sentEmails.length).toBe(emailsBeforeE2E + 1);

      const firstResult = e2eOutcome.report.run.results[0];
      const firstAttempt = firstResult?.attempts[0];
      expect(firstAttempt?.status).toBe("passed");

      const actSteps = (firstAttempt?.steps ?? []).filter(
        (step) => step.api === "agent.act",
      );
      expect(actSteps).toHaveLength(1);
      for (const step of actSteps) {
        expect(step.metrics?.modelCalls ?? 0).toBe(0);
      }

      const tracesReportPath = path.join(
        e2eProjectDir,
        ".e2e/softprobe-traces.json",
      );
      expect(existsSync(tracesReportPath)).toBe(true);
      const tracesReport = JSON.parse(readFileSync(tracesReportPath, "utf8")) as {
        traces: Array<{ mode: string; outboundCall?: { url: string; status: number } }>;
      };
      expect(tracesReport.traces).toHaveLength(1);
      expect(tracesReport.traces[0]?.mode).toBe("outboundHttp");
      expect(tracesReport.traces[0]?.outboundCall?.status).toBe(200);
      expect(tracesReport.traces[0]?.outboundCall?.url).toContain("/v1/email/send");
    },
    90_000,
  );

  it(
    "replays unlabeled twin comboboxes, icon-font button names, and MPA load navigations in zero-LLM e2e across repeated runs",
    async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage({
          viewport: { width: 1280, height: 720 },
          extraHTTPHeaders: { "x-enable-web-record": "1" },
        });
        await page.goto(`${appOrigin}/ota/index.html`);
        await page.locator("#fromCity").selectOption("LHR");
        await page.locator("#toCity").selectOption("CDG");
        await page.locator("#departureDate").fill("2026-12-01");
        await page.getByRole("button", { name: /search/i }).click();
        await page.waitForURL(/\/ota\/list\.html/);
        await page.evaluate(async () => {
          const session: unknown = Reflect.get(window, "__softprobeSession");
          if (typeof session === "object" && session !== null) {
            const flushFn: unknown = Reflect.get(session, "flush");
            if (typeof flushFn === "function") {
              await Reflect.apply(flushFn, session, []);
            }
          }
        });
      } finally {
        await browser.close();
      }

      const fetched = await fetchSessionSpansFromBlackbox({
        endpoint: blackboxOrigin,
        sessionId: "sess_live_unlabeled_twins_001",
        token: "bb_live_token",
        workspaceId: "ws_live_001",
      });
      const bundle = extractSessionBundleFromSpans(
        { sessionId: fetched.sessionId, spans: fetched.spans },
        {
          sessionId: "sess_live_unlabeled_twins_001",
          baseOrigin: appOrigin,
          tracesByTraceId: fetched.tracesByTraceId,
        },
      );

      const e2eProjectDir = createTempProject("sp-compiled-ota-e2e-");
      const e2eSuite = compileSessionToE2E(bundle, {
        projectId: "sp-compiled-ota-e2e",
        appIdentity: "ota-web-app",
        targetUrl: appOrigin,
        sinkEndpoint: blackboxOrigin,
        workspaceId: "ws_live_001",
      });
      for (const file of [...e2eSuite.files, ...e2eSuite.cacheFiles]) {
        const targetPath = path.join(e2eProjectDir, file.relativePath);
        mkdirSync(path.dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, file.content, "utf8");
      }

      const scopedEnvOverrides: Record<string, string | undefined> = {
        E2E_TELEMETRY_DISABLED: "1",
        APP_URL: appOrigin,
        SOFTPROBE_SINK_ENDPOINT: blackboxOrigin,
        SOFTPROBE_API_KEY: "bb_live_token",
        SOFTPROBE_WORKSPACE_ID: "ws_live_001",
        OPENAI_API_KEY: undefined,
        ANTHROPIC_API_KEY: undefined,
        AI_GATEWAY_API_KEY: undefined,
        OPENROUTER_API_KEY: undefined,
        GEMINI_API_KEY: undefined,
        GOOGLE_GENERATIVE_AI_API_KEY: undefined,
      };
      const savedEnv = new Map<string, string | undefined>();
      for (const [k, v] of Object.entries(scopedEnvOverrides)) {
        savedEnv.set(k, process.env[k]);
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }

      const emailsBefore = sentEmails.length;
      try {
        const run1 = await runE2ESuite({
          cwd: e2eProjectDir,
          config: path.join(e2eProjectDir, "e2e.config.ts"),
        });
        if (run1.exitCode !== 0) {
          throw new Error(`run1 failed:\n${JSON.stringify(run1.report, null, 2)}`);
        }
        expect(run1.exitCode).toBe(0);
        expect(run1.report.run.summary.passed).toBe(1);
        expect(run1.report.run.usage.modelTokens).toBe(0);
        expect(run1.report.run.usage.maxModelCallsInStep).toBe(0);

        const run2 = await runE2ESuite({
          cwd: e2eProjectDir,
          config: path.join(e2eProjectDir, "e2e.config.ts"),
        });
        expect(run2.exitCode).toBe(0);
        expect(run2.report.run.summary.passed).toBe(1);
        expect(run2.report.run.usage.modelTokens).toBe(0);
        expect(run2.report.run.usage.maxModelCallsInStep).toBe(0);
      } finally {
        for (const [k, prev] of savedEnv.entries()) {
          if (prev === undefined) delete process.env[k];
          else process.env[k] = prev;
        }
      }
      expect(sentEmails.slice(emailsBefore)).toEqual([
        { to: "LHR-CDG@ndc.local", subject: "2026-12-01" },
        { to: "LHR-CDG@ndc.local", subject: "2026-12-01" },
      ]);
    },
    90_000,
  );
});
