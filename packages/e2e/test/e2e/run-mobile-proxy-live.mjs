#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { SpanKind, SpanStatusCode, trace, ROOT_CONTEXT } from "@opentelemetry/api";
import { BasicTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, "../..");
const repoRoot = path.resolve(packageDir, "../..");

function buildAugmentedEnv(extraEnv = {}) {
  const home = process.env.HOME ?? os.homedir();
  const sdkRoot =
    process.env.ANDROID_HOME ??
    process.env.ANDROID_SDK_ROOT ??
    path.join(home, ".local", "share", "android-sdk");
  const extraPaths = [
    path.join(home, ".local", "bin"),
    path.join(sdkRoot, "platform-tools"),
  ].filter((dir) => fs.existsSync(dir));
  const currentPath = process.env.PATH ?? "";
  return {
    ...process.env,
    ANDROID_HOME: sdkRoot,
    PATH: [...extraPaths, currentPath].filter(Boolean).join(path.delimiter),
    E2E_TELEMETRY_DISABLED: "1",
    ...extraEnv,
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runCmd(cmd, args, options = {}) {
  const { env: extraEnv, ...restOptions } = options;
  return execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...restOptions,
    env: buildAugmentedEnv({ HOME: os.homedir(), ...extraEnv }),
  });
}

function runAdb(serial, args, options = {}) {
  assert.ok(serial, "An explicit Android serial is required for every adb command");
  return runCmd("adb", ["-s", serial, ...args], options);
}

async function runE2eCli(e2eBin, suiteProjectDir, configPath, env) {
  const res = await new Promise((resolve, reject) => {
    const child = spawn(e2eBin, ["run", "--config", configPath], {
      cwd: suiteProjectDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: buildAugmentedEnv({ HOME: os.homedir(), ...env }),
    });
    const outChunks = [];
    const errChunks = [];
    child.stdout.on("data", (chunk) => outChunks.push(chunk));
    child.stderr.on("data", (chunk) => errChunks.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({
        status: code,
        stdout: Buffer.concat(outChunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
      });
    });
  });
  if (res.status !== 0) {
    const reportFile = path.join(suiteProjectDir, ".e2e", "report.json");
    let reportSummary = "";
    if (fs.existsSync(reportFile)) {
      try {
        const rep = JSON.parse(fs.readFileSync(reportFile, "utf8"));
        reportSummary = JSON.stringify(
          {
            errors: rep.run?.errors,
            results: (rep.run?.results ?? []).map((r) => ({
              testId: r.testId,
              status: r.status,
              attempts: (r.attempts ?? []).map((a) => ({
                status: a.status,
                error: a.error,
                steps: (a.steps ?? []).map((s) => ({
                  api: s.api,
                  label: s.label,
                  status: s.status,
                  error: s.error,
                })),
              })),
            })),
          },
          null,
          2,
        );
      } catch (err) {
        reportSummary = String(err);
      }
    }
    throw new Error(
      `e2e run failed with exit ${res.status}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}\nreport:\n${reportSummary}`,
    );
  }
}

async function pollUntil(label, fn, { timeoutMs = 45_000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) {
        return value;
      }
    } catch (err) {
      lastErr = err;
    }
    await delay(intervalMs);
  }
  const detail = lastErr ? `: ${lastErr.message}` : "";
  throw new Error(`Timed out waiting for ${label}${detail}`);
}

function resolveFixtureBuildScript() {
  const candidates = [
    process.env.SP_MOBILE_FIXTURE_BUILD_SCRIPT?.trim(),
    path.resolve(repoRoot, "../dev-mobile-avd/products/blackbox/e2e/mobile/fixture-app/build-apk.sh"),
    path.resolve(repoRoot, "../products/blackbox/e2e/mobile/fixture-app/build-apk.sh"),
    path.resolve(repoRoot, "../../products/blackbox/e2e/mobile/fixture-app/build-apk.sh"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `Could not locate mobile fixture build-apk.sh. Checked: ${candidates.join(", ")}`,
  );
}

async function resolveExclusiveDevice(explicitTarget) {
  assert.ok(
    explicitTarget,
    "Set SP_ANDROID_ADB_TARGET or ANDROID_SERIAL so the live mobile runner targets an explicit device slot",
  );
  runCmd("adb", ["start-server"]);
  if (explicitTarget.includes(":")) {
    spawnSync("adb", ["connect", explicitTarget], {
      stdio: "ignore",
      env: buildAugmentedEnv(),
    });
  }
  await pollUntil(
    `adb target ${explicitTarget} state=device`,
    () => {
      if (explicitTarget.includes(":")) {
        spawnSync("adb", ["connect", explicitTarget], {
          stdio: "ignore",
          env: buildAugmentedEnv(),
        });
      }
      const state = runAdb(explicitTarget, ["get-state"]).trim();
      return state === "device" ? explicitTarget : null;
    },
    { timeoutMs: 30_000, intervalMs: 500 },
  );

  await pollUntil(
    `Android boot completion on ${explicitTarget}`,
    () => {
      const booted = runAdb(explicitTarget, ["shell", "getprop", "sys.boot_completed"]).trim();
      if (booted !== "1") return false;
      const pmPath = runAdb(explicitTarget, ["shell", "pm", "path", "android"]).trim();
      return pmPath.startsWith("package:");
    },
    { timeoutMs: 60_000, intervalMs: 500 },
  );

  spawnSync("adb", ["-s", explicitTarget, "shell", "input", "keyevent", "KEYCODE_WAKEUP"], {
    stdio: "ignore",
    env: buildAugmentedEnv(),
  });
  spawnSync("adb", ["-s", explicitTarget, "shell", "wm", "dismiss-keyguard"], {
    stdio: "ignore",
    env: buildAugmentedEnv(),
  });
  spawnSync("adb", ["-s", explicitTarget, "shell", "settings", "put", "system", "show_touches", "1"], {
    stdio: "ignore",
    env: buildAugmentedEnv(),
  });

  return explicitTarget;
}

function readHttpBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function listenEphemeral(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Expected numeric TCP address"));
        return;
      }
      resolve({ port: addr.port, origin: `http://127.0.0.1:${addr.port}` });
    });
  });
}

function closeServer(server) {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

function hrTimeToUnixNanoString(hrTime) {
  const [sec, nsec] = hrTime;
  return String(BigInt(sec) * 1_000_000_000n + BigInt(nsec));
}

function serializeReadableSpanToOtlp(span) {
  const spanCtx = span.spanContext();
  const attrs = Object.entries(span.attributes ?? {}).map(([key, val]) => {
    if (typeof val === "number" && Number.isInteger(val)) {
      return { key, value: { intValue: val } };
    }
    if (typeof val === "number") {
      return { key, value: { doubleValue: val } };
    }
    if (typeof val === "boolean") {
      return { key, value: { boolValue: val } };
    }
    return { key, value: { stringValue: String(val) } };
  });

  const otlpKind =
    span.kind === SpanKind.SERVER
      ? 2
      : span.kind === SpanKind.CLIENT
        ? 3
        : 1;

  const parentSpanId = span.parentSpanContext?.spanId ?? span.parentSpanId;

  return {
    traceId: spanCtx.traceId,
    spanId: spanCtx.spanId,
    ...(parentSpanId ? { parentSpanId } : {}),
    name: span.name,
    kind: otlpKind,
    startTimeUnixNano: hrTimeToUnixNanoString(span.startTime),
    endTimeUnixNano: hrTimeToUnixNanoString(span.endTime),
    status: { code: span.status.code },
    attributes: attrs,
  };
}

class BlackboxHttpJsonSpanExporter {
  #tracesUrl;
  #token;
  #workspaceId;
  #serviceName;
  #inflight = new Set();

  constructor({ endpoint, token, workspaceId, serviceName }) {
    this.#tracesUrl = `${endpoint.replace(/\/+$/, "")}/v1/traces`;
    this.#token = token;
    this.#workspaceId = workspaceId;
    this.#serviceName = serviceName;
  }

  export(spans, resultCallback) {
    const payload = {
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: this.#serviceName } },
            ],
          },
          scopeSpans: [
            {
              scope: { name: "invite-otel-backend", version: "1.0.0" },
              spans: spans.map(serializeReadableSpanToOtlp),
            },
          ],
        },
      ],
    };

    const task = fetch(this.#tracesUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.#token}`,
        "X-Workspace-Id": this.#workspaceId,
      },
      body: JSON.stringify(payload),
    })
      .then(() => {
        resultCallback({ code: 0 });
      })
      .catch((error) => {
        resultCallback({ code: 1, error });
      })
      .finally(() => {
        this.#inflight.delete(task);
      });

    this.#inflight.add(task);
  }

  async forceFlush() {
    await Promise.allSettled([...this.#inflight]);
  }

  async shutdown() {
    await this.forceFlush();
  }
}

function extractAttrString(attributes, targetKey) {
  if (!Array.isArray(attributes)) return undefined;
  for (const entry of attributes) {
    if (entry?.key === targetKey) {
      const val = entry.value ?? {};
      if (typeof val.stringValue === "string") return val.stringValue;
      if (val.intValue !== undefined) return String(val.intValue);
    }
  }
  return undefined;
}

async function startInProcessBlackboxAndOtelBackend({ token, workspaceId }) {
  const rawOtlpBodies = [];
  const spansByTraceId = new Map();
  const spansBySessionId = new Map();
  const uiActionSpans = [];
  const downstreamPayloads = [];

  const blackboxServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (req.headers["x-workspace-id"] !== workspaceId) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "missing_workspace" }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/traces") {
      const rawText = await readHttpBody(req);
      rawOtlpBodies.push(rawText);
      const parsed = JSON.parse(rawText);

      for (const rs of parsed.resourceSpans ?? []) {
        const resAttrs = rs.resource?.attributes ?? [];
        for (const scope of rs.scopeSpans ?? []) {
          for (const sp of scope.spans ?? []) {
            const traceId = String(sp.traceId ?? "").toLowerCase();
            if (traceId) {
              const list = spansByTraceId.get(traceId) ?? [];
              list.push({ resourceAttrs: resAttrs, span: sp });
              spansByTraceId.set(traceId, list);
            }
            const sessionId = extractAttrString(sp.attributes, "sp.session.id");
            if (sessionId) {
              const sList = spansBySessionId.get(sessionId) ?? [];
              sList.push({ resourceAttrs: resAttrs, span: sp });
              spansBySessionId.set(sessionId, sList);
            }
            if (
              sp.name === "softprobe.ui.action" ||
              extractAttrString(sp.attributes, "sp.observation.type") === "ui_action"
            ) {
              uiActionSpans.push({ resourceAttrs: resAttrs, span: sp });
            }
          }
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
      return;
    }

    const traceMatch = /^\/api\/traces\/([0-9a-f]{32})$/.exec(url.pathname);
    if (req.method === "GET" && traceMatch) {
      const items = spansByTraceId.get(traceMatch[1]);
      if (!items || items.length === 0) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "trace_not_found" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          resourceSpans: items.map((item) => ({
            resource: { attributes: item.resourceAttrs },
            scopeSpans: [{ spans: [item.span] }],
          })),
        }),
      );
      return;
    }

    const sessionMatch = /^\/v1\/llm\/sessions\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && sessionMatch) {
      const sessionId = decodeURIComponent(sessionMatch[1]);
      const items = spansBySessionId.get(sessionId);
      if (!items || items.length === 0) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "session_not_found" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          session_id: sessionId,
          resourceSpans: items.map((item) => ({
            resource: { attributes: item.resourceAttrs },
            scopeSpans: [{ spans: [item.span] }],
          })),
        }),
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  const { origin: blackboxOrigin } = await listenEphemeral(blackboxServer);

  const downstreamServer = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/v1/email/send") {
      const raw = await readHttpBody(req);
      const body = JSON.parse(raw || "{}");
      downstreamPayloads.push(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, queued: true }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  const { origin: downstreamOrigin } = await listenEphemeral(downstreamServer);

  const exporter = new BlackboxHttpJsonSpanExporter({
    endpoint: blackboxOrigin,
    token,
    workspaceId,
    serviceName: "invite-otel-service",
  });
  const tracerProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const tracer = tracerProvider.getTracer("invite-http-server", "1.0.0");

  const inviteServer = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/api/invites") {
      const rawBody = await readHttpBody(req);
      let parsedBody = {};
      try {
        parsedBody = JSON.parse(rawBody || "{}");
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
        return;
      }

      const rawTp = typeof req.headers["traceparent"] === "string" ? req.headers["traceparent"] : "";
      const tpMatch = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(rawTp.trim());
      const traceId = tpMatch ? tpMatch[1] : randomBytes(16).toString("hex");
      const remoteSpanId = tpMatch ? tpMatch[2] : randomBytes(8).toString("hex");

      const baggageHeader = typeof req.headers["baggage"] === "string" ? req.headers["baggage"] : "";
      const sessionMatch = /sp\.session\.id=([^,\s]+)/.exec(baggageHeader);
      const sessionId = sessionMatch ? sessionMatch[1] : undefined;

      const parentContext = trace.setSpanContext(ROOT_CONTEXT, {
        traceId,
        spanId: remoteSpanId,
        traceFlags: 1,
        isRemote: true,
      });

      const serverSpan = tracer.startSpan(
        "POST /api/invites",
        {
          kind: SpanKind.SERVER,
          attributes: {
            "http.request.method": "POST",
            "http.route": "/api/invites",
            "url.path": "/api/invites",
            ...(sessionId ? { "sp.session.id": sessionId } : {}),
          },
        },
        parentContext,
      );

      const serverContext = trace.setSpan(parentContext, serverSpan);
      const email = typeof parsedBody.email === "string" ? parsedBody.email.trim() : "";
      const password = typeof parsedBody.password === "string" ? parsedBody.password : "";

      if (!email || !password) {
        serverSpan.setAttribute("http.response.status_code", 400);
        serverSpan.end();
        await tracerProvider.forceFlush();
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Email and password required" }));
        return;
      }

      if (email === "existing@acme.com") {
        serverSpan.setAttribute("http.response.status_code", 409);
        serverSpan.setStatus({ code: SpanStatusCode.OK });
        serverSpan.end();
        await tracerProvider.forceFlush();
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Already a member" }));
        return;
      }

      const outboundUrl = `${downstreamOrigin}/v1/email/send`;
      const outboundRequestBody = JSON.stringify({ to: email });

      const clientSpan = tracer.startSpan(
        "POST /v1/email/send",
        {
          kind: SpanKind.CLIENT,
          attributes: {
            "http.request.method": "POST",
            "url.full": outboundUrl,
            "http.request.body": outboundRequestBody,
            ...(sessionId ? { "sp.session.id": sessionId } : {}),
          },
        },
        serverContext,
      );

      const downstreamRes = await fetch(outboundUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: outboundRequestBody,
      });
      const downstreamText = await downstreamRes.text();

      clientSpan.setAttribute("http.response.status_code", downstreamRes.status);
      clientSpan.setAttribute("http.response.body", downstreamText);
      clientSpan.setStatus({ code: SpanStatusCode.OK });
      clientSpan.end();

      serverSpan.setAttribute("http.response.status_code", 200);
      serverSpan.setStatus({ code: SpanStatusCode.OK });
      serverSpan.end();
      await tracerProvider.forceFlush();

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  const { origin: inviteOrigin } = await listenEphemeral(inviteServer);

  return {
    blackboxOrigin,
    inviteOrigin,
    downstreamOrigin,
    rawOtlpBodies,
    uiActionSpans,
    downstreamPayloads,
    async close() {
      await tracerProvider.shutdown();
      await Promise.all([
        closeServer(inviteServer),
        closeServer(downstreamServer),
        closeServer(blackboxServer),
      ]);
    },
  };
}

function createFrameSampler(serial, framesDir) {
  fs.mkdirSync(framesDir, { recursive: true });
  let active = true;
  let frameIndex = 0;

  const captureOne = async () => {
    const outFile = path.join(framesDir, `frame-${String(frameIndex).padStart(5, "0")}.png`);
    const pngBuf = await new Promise((resolve) => {
      const child = spawn("adb", ["-s", serial, "exec-out", "screencap", "-p"], {
        stdio: ["ignore", "pipe", "ignore"],
        env: buildAugmentedEnv(),
      });
      const chunks = [];
      child.stdout.on("data", (chunk) => chunks.push(chunk));
      child.once("error", () => resolve(null));
      child.once("close", (code) => {
        resolve(code === 0 ? Buffer.concat(chunks) : null);
      });
    });
    if (pngBuf && pngBuf.length > 1024) {
      fs.writeFileSync(outFile, pngBuf);
      frameIndex += 1;
    }
  };

  const loopPromise = (async () => {
    while (active) {
      await captureOne();
      await delay(140);
    }
    while (frameIndex < 24) {
      await captureOne();
      await delay(60);
    }
  })();

  return {
    async stopAndEncode(outputMp4Path) {
      active = false;
      await loopPromise;
      assert.ok(frameIndex >= 20, `Expected >= 20 captured frames, got ${frameIndex}`);
      const tmpMp4 = `${outputMp4Path}.tmp.${process.pid}.mp4`;
      runCmd("ffmpeg", [
        "-y",
        "-framerate",
        "6",
        "-i",
        path.join(framesDir, "frame-%05d.png"),
        "-vf",
        "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "22",
        "-movflags",
        "+faststart",
        tmpMp4,
      ]);
      fs.renameSync(tmpMp4, outputMp4Path);
      return frameIndex;
    },
  };
}

function startDeviceScreenrecord(serial, remotePath) {
  spawnSync("adb", ["-s", serial, "shell", "rm", "-f", remotePath], {
    stdio: "ignore",
    env: buildAugmentedEnv(),
  });
  const child = spawn(
    "adb",
    ["-s", serial, "shell", "screenrecord", "--bit-rate", "4000000", "--size", "720x1600", remotePath],
    { stdio: ["ignore", "pipe", "pipe"], env: buildAugmentedEnv() },
  );
  return {
    async stopAndPull(localOutPath) {
      if (child.exitCode === null) {
        spawnSync("adb", ["-s", serial, "shell", "pkill", "-SIGINT", "screenrecord"], {
          stdio: "ignore",
          env: buildAugmentedEnv(),
        });
        await pollUntil("screenrecord flush", () => child.exitCode !== null, {
          timeoutMs: 8_000,
          intervalMs: 200,
        }).catch(() => {
          child.kill("SIGTERM");
        });
      }
      const statOut = spawnSync("adb", ["-s", serial, "shell", "wc", "-c", remotePath], {
        encoding: "utf8",
        env: buildAugmentedEnv(),
      });
      const remoteBytes = Number.parseInt(
        (statOut.stdout ?? "").trim().split(/\s+/)[0] ?? "0",
        10,
      );
      if (!Number.isFinite(remoteBytes) || remoteBytes <= 10 * 1024) {
        spawnSync("adb", ["-s", serial, "shell", "rm", "-f", remotePath], {
          stdio: "ignore",
          env: buildAugmentedEnv(),
        });
        return null;
      }
      const tmpMp4 = `${localOutPath}.sr.${process.pid}.mp4`;
      const pullRes = spawnSync("adb", ["-s", serial, "pull", remotePath, tmpMp4], {
        stdio: "ignore",
        env: buildAugmentedEnv(),
      });
      spawnSync("adb", ["-s", serial, "shell", "rm", "-f", remotePath], {
        stdio: "ignore",
        env: buildAugmentedEnv(),
      });
      if (pullRes.status !== 0 || !fs.existsSync(tmpMp4)) {
        fs.rmSync(tmpMp4, { force: true });
        return null;
      }
      try {
        const meta = verifyMp4Artifact(tmpMp4);
        fs.renameSync(tmpMp4, localOutPath);
        return meta;
      } catch {
        fs.rmSync(tmpMp4, { force: true });
        return null;
      }
    },
  };
}

function verifyMp4Artifact(mp4Path) {
  assert.ok(fs.existsSync(mp4Path), `Missing MP4 artifact at ${mp4Path}`);
  const stat = fs.statSync(mp4Path);
  assert.ok(
    stat.size > 10 * 1024,
    `Expected MP4 size > 10240 bytes, got ${stat.size} bytes at ${mp4Path}`,
  );

  const probeJson = runCmd("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-count_frames",
    "-show_entries",
    "stream=codec_name,width,height,nb_read_frames",
    "-show_entries",
    "format=duration",
    "-of",
    "json",
    mp4Path,
  ]);

  const parsed = JSON.parse(probeJson);
  const stream = parsed?.streams?.[0];
  assert.ok(stream, `ffprobe returned no video stream for ${mp4Path}`);
  const width = Number(stream.width ?? 0);
  const height = Number(stream.height ?? 0);
  const frameCount = Number(stream.nb_read_frames ?? 0);
  assert.ok(width >= 320 && height >= 480, `Unexpected video dimensions ${width}x${height}`);
  assert.ok(frameCount >= 20, `Expected >= 20 video frames, got ${frameCount}`);

  const middleOffsetSec = Math.max(0, Number(parsed?.format?.duration ?? 0) * 0.5).toFixed(2);
  const sampleRgb = execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-ss",
      middleOffsetSec,
      "-i",
      mp4Path,
      "-vf",
      "scale=64:64",
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ],
    { maxBuffer: 4 * 1024 * 1024, env: buildAugmentedEnv() },
  );
  assert.equal(sampleRgb.length, 64 * 64 * 3, "Unexpected decoded RGB frame byte length");

  let minLum = 255;
  let maxLum = 0;
  for (let i = 0; i < sampleRgb.length; i += 3) {
    const lum = Math.round(
      0.299 * sampleRgb[i] + 0.587 * sampleRgb[i + 1] + 0.114 * sampleRgb[i + 2],
    );
    if (lum < minLum) minLum = lum;
    if (lum > maxLum) maxLum = lum;
  }
  const lumaSpread = maxLum - minLum;
  assert.ok(
    lumaSpread > 20,
    `Decoded video frame appears blank (luma spread ${lumaSpread} <= 20)`,
  );

  return {
    bytes: stat.size,
    codec: stream.codec_name,
    width,
    height,
    frames: frameCount,
    durationSec: Number(parsed?.format?.duration ?? 0),
    lumaSpread,
  };
}

function renderContactSheet(mp4Path, outPngPath, durationSec) {
  const safeSpan = Math.max(1, Math.ceil(Number(durationSec) || 12));
  runCmd("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-i",
    mp4Path,
    "-vf",
    `fps=12/${safeSpan},scale=320:-1,tile=4x3`,
    "-frames:v",
    "1",
    outPngPath,
  ]);
}

function buildSuiteConfigSource({
  serial,
  blackboxOrigin,
  inviteOrigin,
  token,
  workspaceId,
  mode,
}) {
  const agentBlock =
    mode === "record"
      ? `{
      executor: {
        name: "invite-mobile-seed-executor",
        version: "1.0.0",
        async runStep(ctx) {
          const findField = (node, role, label) => {
            if (!node) return undefined;
            if (node.role === role && (node.name === label || node.text === label)) {
              return node;
            }
            for (const child of node.children ?? []) {
              const hit = findField(child, role, label);
              if (hit) return hit;
            }
            return undefined;
          };

          const emailValue =
            typeof ctx.step.params?.email === "string"
              ? ctx.step.params.email
              : "ada@acme.com";

          const look1 = await ctx.observe({ tree: true });
          const emailField = findField(look1.tree, "textbox", "Teammate email");
          if (!emailField) {
            return { status: "failed", summary: "Teammate email textbox not found" };
          }
          await ctx.actions.type({ id: emailField.id }, emailValue);

          const look2 = await ctx.observe({ tree: true });
          const pwField = findField(look2.tree, "textbox", "Admin password");
          if (!pwField) {
            return { status: "failed", summary: "Admin password textbox not found" };
          }
          await ctx.actions.typeSecret({ id: pwField.id }, "ADMIN_PASSWORD");

          const look3 = await ctx.observe({ tree: true });
          const sendButton = findField(look3.tree, "button", "Send invite");
          if (!sendButton) {
            return { status: "failed", summary: "Send invite button not found: " + look3.text };
          }
          await ctx.actions.tap({ id: sendButton.id });

          const expectedBanner =
            emailValue === "existing@acme.com"
              ? "Error: Already a member"
              : \`Invitation queued for \${emailValue}\`;
          let lastObservedText = "";
          let matched = false;
          for (let attempt = 0; attempt < 30; attempt += 1) {
            const settled = await ctx.observe();
            lastObservedText = settled.text;
            if (settled.text.includes(expectedBanner)) {
              matched = true;
              break;
            }
            await new Promise((r) => setTimeout(r, 200));
          }
          if (!matched) {
            const nonKeyLines = lastObservedText
              .split("\\n")
              .filter((line) => !line.includes(" key \\""))
              .join("\\n");
            return {
              status: "failed",
              summary: \`Expected banner "\${expectedBanner}", saw:\\n\${nonKeyLines}\`,
            };
          }

          return {
            status: "passed",
            summary: \`Submitted invite form for \${emailValue}\`,
          };
        },
      },
    }`
      : `softprobeCachedAgent()`;

  return `import type { E2EConfig } from "e2e";
import { softprobeReporter } from "@softprobe/e2e";
import { softprobeCachedAgent, softprobeMobile } from "@softprobe/e2e/mobile";

const deviceSerial = process.env.SP_ANDROID_ADB_TARGET || process.env.ANDROID_SERIAL || ${JSON.stringify(serial)};

export default {
  projectId: "softprobe-mobile-proxy-live",
  workers: 1,
  retries: 0,
  cache: {
    mode: ${JSON.stringify(mode === "record" ? "read-write" : "read-only")},
  },
  secrets: {
    ADMIN_PASSWORD: process.env.E2E_SECRET_ADMIN_PASSWORD ?? "placeholder_unused_min6",
  },
  agents: {
    default: ${agentBlock},
  },
  tests: "tests/**/*.e2e.ts",
  targets: [
    {
      name: "android-avd-proxy",
      engine: softprobeMobile({
        platform: "android",
        device: deviceSerial,
        endpoint: ${JSON.stringify(blackboxOrigin)},
        token: ${JSON.stringify(token)},
        workspaceId: ${JSON.stringify(workspaceId)},
        correlation: {
          mode: "proxy",
          upstreamOrigin: ${JSON.stringify(inviteOrigin)},
        },
        pollTimeoutMs: 10000,
        pollIntervalMs: 150,
        settleMs: 150,
      }),
      app: {
        bundleId: "com.softprobe.fixture.invite",
      },
    },
  ],
  reporters: [softprobeReporter()],
} satisfies E2EConfig;
`;
}

const TEST_FILE_SOURCE = `import { z } from "zod";
import { describe, expect, secrets, test } from "@softprobe/e2e/mobile";

const EmailPayloadSchema = z.object({
  to: z.string().email(),
});

describe("@softprobe/e2e/mobile reverse-proxy correlation on Android AVD", () => {
  test("queues teammate invitation, redacts ADMIN_PASSWORD, and verifies downstream email HTTP payload", async ({
    app,
    agent,
    screen,
    trace,
  }) => {
    await app.open();

    await agent.act(
      "fill {email} into Teammate email, fill {password} into Admin password, and tap Send invite",
      {
        params: {
          email: "ada@acme.com",
          password: secrets.get("ADMIN_PASSWORD"),
        },
      },
    );

    await expect(screen.getByText("Invitation queued for ada@acme.com")).toBeVisible();

    const outbound = await trace.outboundHttp({
      triggeredBy: { method: "POST", path: "/api/invites" },
      method: "POST",
      url: /\\/v1\\/email\\/send$/,
      status: 200,
    });

    const parsedBody = expect(outbound.request.json).toMatchSchema(EmailPayloadSchema);
    expect(parsedBody).toEqual({ to: "ada@acme.com" });
  });

  test("enforces expectNoOutboundHttp when POST /api/invites returns 409 for duplicate member", async ({
    app,
    agent,
    screen,
    trace,
  }) => {
    await app.open();

    await agent.act(
      "fill {email} into Teammate email, fill {password} into Admin password, and tap Send invite",
      {
        params: {
          email: "existing@acme.com",
          password: secrets.get("ADMIN_PASSWORD"),
        },
      },
    );

    await expect(screen.getByText("Error: Already a member")).toBeVisible();

    await trace.expectNoOutboundHttp({
      triggeredBy: { method: "POST", path: "/api/invites" },
    });
  });
});
`;

async function main() {
  const explicitTarget = (
    process.env.SP_ANDROID_ADB_TARGET ??
    process.env.ANDROID_SERIAL ??
    ""
  ).trim();
  const videoOutPath = path.resolve(
    (process.env.SP_AVD_VIDEO_OUT ?? "").trim() ||
      path.join(process.cwd(), ".audit", "videos", "mobile-proxy-live.mp4"),
  );
  fs.mkdirSync(path.dirname(videoOutPath), { recursive: true });

  const tempWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), "sp-mobile-proxy-live-"));
  const agentStateDir = path.join(tempWorkDir, "agent-device-state");
  const fixtureBuildDir = path.join(tempWorkDir, "fixture-apk-build");
  const framesDir = path.join(tempWorkDir, "frames");
  const suiteProjectDir = path.join(tempWorkDir, "suite");
  fs.mkdirSync(agentStateDir, { recursive: true });
  fs.mkdirSync(fixtureBuildDir, { recursive: true });
  fs.mkdirSync(path.join(suiteProjectDir, "tests"), { recursive: true });
  fs.symlinkSync(
    path.join(repoRoot, "node_modules"),
    path.join(suiteProjectDir, "node_modules"),
    "dir",
  );

  const appPackage = "com.softprobe.fixture.invite";
  const adminSecretPlaintext = "s3cr3t_admin_pw_2026!";
  const sinkToken = "bb_live_mobile_tok";
  const sinkWorkspaceId = "ws_live_mobile_01";

  const serial = await resolveExclusiveDevice(explicitTarget);
  const buildApkScript = resolveFixtureBuildScript();
  const builtApkOut = path.join(fixtureBuildDir, "fixture-invite-debug.apk");
  const apkStdout = runCmd("bash", [buildApkScript, builtApkOut], {
    env: { SP_FIXTURE_BUILD_DIR: fixtureBuildDir },
  });
  const apkPath = apkStdout.trim().split(/\r?\n/).pop();
  assert.ok(apkPath && fs.existsSync(apkPath), `Built APK missing at ${apkPath}`);

  spawnSync("adb", ["-s", serial, "uninstall", appPackage], {
    stdio: "ignore",
    env: buildAugmentedEnv(),
  });
  runAdb(serial, ["install", "-r", apkPath]);
  spawnSync("adb", ["-s", serial, "shell", "am", "force-stop", appPackage], {
    stdio: "ignore",
    env: buildAugmentedEnv(),
  });
  spawnSync("adb", ["-s", serial, "shell", "pm", "clear", appPackage], {
    stdio: "ignore",
    env: buildAugmentedEnv(),
  });

  const backend = await startInProcessBlackboxAndOtelBackend({
    token: sinkToken,
    workspaceId: sinkWorkspaceId,
  });

  const remoteVideoPath = "/sdcard/Download/sp-mobile-proxy-live.mp4";
  let screenrec = null;
  let sampler = null;

  try {
    const configPath = path.join(suiteProjectDir, "e2e.config.ts");
    fs.writeFileSync(
      path.join(suiteProjectDir, "tests", "invite-mobile.e2e.ts"),
      TEST_FILE_SOURCE,
      "utf8",
    );

    const commonRunEnv = {
      SP_ANDROID_ADB_TARGET: serial,
      ANDROID_SERIAL: serial,
      AGENT_DEVICE_STATE_DIR: agentStateDir,
      E2E_SECRET_ADMIN_PASSWORD: adminSecretPlaintext,
      E2E_TELEMETRY_DISABLED: "1",
    };

    fs.writeFileSync(
      configPath,
      buildSuiteConfigSource({
        serial,
        blackboxOrigin: backend.blackboxOrigin,
        inviteOrigin: backend.inviteOrigin,
        token: sinkToken,
        workspaceId: sinkWorkspaceId,
        mode: "record",
      }),
      "utf8",
    );

    const e2eBin = path.join(repoRoot, "node_modules", ".bin", "e2e");
    await runE2eCli(e2eBin, suiteProjectDir, configPath, commonRunEnv);

    const cacheDir = path.join(suiteProjectDir, ".e2e", "cache");
    assert.ok(fs.existsSync(cacheDir), "Expected .e2e/cache directory after Run 1");
    const cacheFiles = fs.readdirSync(cacheDir).filter((f) => f.endsWith(".json"));
    assert.ok(cacheFiles.length >= 2, `Expected >= 2 cache files, got ${cacheFiles.length}`);
    for (const file of cacheFiles) {
      const cacheText = fs.readFileSync(path.join(cacheDir, file), "utf8");
      assert.ok(
        !cacheText.includes(adminSecretPlaintext),
        `Cache file ${file} must never contain plaintext secret`,
      );
    }

    backend.rawOtlpBodies.length = 0;
    backend.uiActionSpans.length = 0;
    backend.downstreamPayloads.length = 0;

    spawnSync("adb", ["-s", serial, "shell", "am", "force-stop", appPackage], {
      stdio: "ignore",
      env: buildAugmentedEnv(),
    });
    spawnSync("adb", ["-s", serial, "shell", "pm", "clear", appPackage], {
      stdio: "ignore",
      env: buildAugmentedEnv(),
    });

    screenrec = startDeviceScreenrecord(serial, remoteVideoPath);
    sampler = createFrameSampler(serial, framesDir);

    fs.writeFileSync(
      configPath,
      buildSuiteConfigSource({
        serial,
        blackboxOrigin: backend.blackboxOrigin,
        inviteOrigin: backend.inviteOrigin,
        token: sinkToken,
        workspaceId: sinkWorkspaceId,
        mode: "replay",
      }),
      "utf8",
    );

    await runE2eCli(e2eBin, suiteProjectDir, configPath, {
      ...commonRunEnv,
      CI: "true",
    });

    const srMeta = await screenrec.stopAndPull(videoOutPath);
    let videoSource = "screenrecord";
    if (!srMeta) {
      videoSource = "screencap-x264";
      await sampler.stopAndEncode(videoOutPath);
    } else {
      await sampler.stopAndEncode(path.join(tempWorkDir, "discard-sampler.mp4"));
    }
    const videoMeta = verifyMp4Artifact(videoOutPath);

    const contactSheetEnv = process.env.SP_AVD_CONTACT_SHEET_OUT?.trim();
    if (contactSheetEnv) {
      const sheetOut = path.resolve(contactSheetEnv);
      fs.mkdirSync(path.dirname(sheetOut), { recursive: true });
      renderContactSheet(videoOutPath, sheetOut, videoMeta.durationSec);
    }

    const reportPath = path.join(suiteProjectDir, ".e2e", "report.json");
    assert.ok(fs.existsSync(reportPath), "Missing .e2e/report.json after Run 2");
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(report.run?.status, "passed");
    assert.equal(report.run?.summary?.passed, 2);
    assert.equal(report.run?.summary?.failed, 0);
    assert.equal(
      report.run?.usage?.modelTokens,
      0,
      `Expected modelTokens=0 on CI cached replay, got ${report.run?.usage?.modelTokens}`,
    );
    assert.equal(report.run?.usage?.maxModelCallsInStep, 0);

    const tracesReportPath = path.join(suiteProjectDir, ".e2e", "softprobe-traces.json");
    assert.ok(fs.existsSync(tracesReportPath), "Missing .e2e/softprobe-traces.json");
    const tracesReport = JSON.parse(fs.readFileSync(tracesReportPath, "utf8"));
    assert.equal(tracesReport.traces.length, 2);
    const verifiedTraceIds = new Set(tracesReport.traces.map((t) => t.traceId));

    assert.equal(
      backend.downstreamPayloads.length,
      1,
      `Expected exactly 1 downstream email call across positive + 409 tests, got ${backend.downstreamPayloads.length}`,
    );
    assert.deepEqual(backend.downstreamPayloads[0], { to: "ada@acme.com" });

    assert.ok(
      backend.rawOtlpBodies.length > 0,
      "Expected in-process Blackbox /v1/traces sink to receive OTLP batches",
    );
    for (const rawBody of backend.rawOtlpBodies) {
      assert.ok(
        !rawBody.includes(adminSecretPlaintext),
        "Plaintext ADMIN_PASSWORD leaked into exported OTLP /v1/traces payload",
      );
    }

    assert.ok(
      backend.uiActionSpans.length >= 6,
      `Expected >= 6 softprobe.ui.action spans across 2 mobile tests, got ${backend.uiActionSpans.length}`,
    );

    const decodedUiActions = backend.uiActionSpans.map(({ span }) => {
      const payloadRaw = extractAttrString(span.attributes, "sp.ui.action.payload") ?? "";
      assert.ok(
        payloadRaw.startsWith("sp.json:"),
        "Expected sp.ui.action.payload to carry sp.json: prefix",
      );
      const action = JSON.parse(payloadRaw.slice("sp.json:".length));
      assert.equal(action.schemaVersion, "sp-ui-action-1");
      assert.equal(action.captureSource, "host_agent");
      assert.equal(action.platform, "android");
      return action;
    });

    const secretFills = decodedUiActions.filter(
      (a) =>
        a.verb?.name === "fill" &&
        a.verb?.value?.kind === "secret" &&
        a.verb?.value?.slot === "ADMIN_PASSWORD",
    );
    assert.equal(
      secretFills.length,
      2,
      `Expected 2 redacted ADMIN_PASSWORD secret fills, got ${secretFills.length}`,
    );

    const causedTraceIdsFromUi = new Set(
      decodedUiActions.flatMap((a) => (a.causedTraces ?? []).map((ct) => ct.traceId)),
    );
    for (const verifiedTraceId of verifiedTraceIds) {
      assert.ok(
        causedTraceIdsFromUi.has(verifiedTraceId),
        `Expected verified traceId ${verifiedTraceId} to be linked in softprobe.ui.action causedTraces`,
      );
    }

    process.stdout.write(
      `${JSON.stringify({
        status: "PASS",
        serial,
        modelTokens: report.run.usage.modelTokens,
        uiActionSpanCount: decodedUiActions.length,
        verifiedTraces: [...verifiedTraceIds],
        video: {
          path: videoOutPath,
          source: videoSource,
          ...videoMeta,
        },
      })}\n`,
    );
  } finally {
    spawnSync("adb", ["-s", serial, "shell", "am", "force-stop", appPackage], {
      stdio: "ignore",
      env: buildAugmentedEnv(),
    });
    await backend.close();
    fs.rmSync(tempWorkDir, { recursive: true, force: true });
  }
}

await main();
