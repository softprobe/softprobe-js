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
import { build as esbuildBuild } from "esbuild";
import { createTraceScope } from "../../e2e/dist/fixtures.js";
import { BlackboxSink } from "../../e2e/dist/internal/blackbox-sink.js";
import { createBlackboxSessionTriggerSource } from "../../e2e/dist/internal/trigger-source.js";
import { extractSessionBundleFromSpans } from "../../e2e/dist/session-compiler.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(scriptDir, "..");
const distEntryPath = path.join(pkgRoot, "dist", "index.js");
const appPackage = "com.softprobe.rn.invite";
const appActivity = `${appPackage}/.RnWebViewInviteActivity`;
const targetSessionId = "sp-rn-avd-session-1";
const rawSecretPassword = "rn-live-secret-pw!2026";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveSdkRoot() {
  const fromEnv = (process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? "").trim();
  if (fromEnv) return fromEnv;
  return path.join(os.homedir(), ".local", "share", "android-sdk");
}

function buildToolEnv() {
  const sdkRoot = resolveSdkRoot();
  const extraPaths = [
    path.join(os.homedir(), ".local", "bin"),
    path.join(sdkRoot, "platform-tools"),
    path.join(sdkRoot, "build-tools", "35.0.0"),
  ];
  return {
    ...process.env,
    ANDROID_HOME: sdkRoot,
    PATH: `${extraPaths.join(path.delimiter)}${path.delimiter}${process.env.PATH ?? ""}`,
    E2E_TELEMETRY_DISABLED: "1",
  };
}

const toolEnv = buildToolEnv();

function runCmd(cmd, args, options = {}) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    env: toolEnv,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function runAdb(serial, args, options = {}) {
  const fullArgs = serial ? ["-s", serial, ...args] : args;
  return runCmd("adb", fullArgs, options);
}

async function pollUntil(label, fn, { timeoutMs = 45_000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastErr = err;
    }
    await delay(intervalMs);
  }
  const detail = lastErr instanceof Error ? `: ${lastErr.message}` : "";
  throw new Error(`Timed out waiting for ${label}${detail}`);
}

async function resolveReadyDevice(explicitTarget) {
  runCmd("adb", ["start-server"]);
  if (explicitTarget) {
    if (explicitTarget.includes(":")) {
      spawnSync("adb", ["connect", explicitTarget], { env: toolEnv, stdio: "ignore" });
    }
    await pollUntil(
      `adb target ${explicitTarget} state=device`,
      () => {
        if (explicitTarget.includes(":")) {
          spawnSync("adb", ["connect", explicitTarget], { env: toolEnv, stdio: "ignore" });
        }
        const state = runAdb(explicitTarget, ["get-state"]).trim();
        return state === "device" ? explicitTarget : null;
      },
      { timeoutMs: 30_000, intervalMs: 500 },
    );
    return explicitTarget;
  }

  return pollUntil(
    "connected adb device",
    () => {
      const out = runCmd("adb", ["devices"]);
      for (const line of out.split(/\r?\n/).slice(1)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2 && parts[1] === "device") {
          return parts[0];
        }
      }
      return null;
    },
    { timeoutMs: 15_000, intervalMs: 500 },
  );
}

async function waitForAndroidBoot(serial) {
  await pollUntil(
    `Android boot completion on ${serial}`,
    () => {
      const booted = runAdb(serial, ["shell", "getprop", "sys.boot_completed"]).trim();
      if (booted !== "1") return false;
      const pmPath = runAdb(serial, ["shell", "pm", "path", "android"]).trim();
      return pmPath.startsWith("package:");
    },
    { timeoutMs: 60_000, intervalMs: 500 },
  );
  spawnSync("adb", ["-s", serial, "shell", "input", "keyevent", "KEYCODE_WAKEUP"], {
    env: toolEnv,
    stdio: "ignore",
  });
  spawnSync("adb", ["-s", serial, "shell", "wm", "dismiss-keyguard"], {
    env: toolEnv,
    stdio: "ignore",
  });
  spawnSync("adb", ["-s", serial, "shell", "settings", "put", "system", "show_touches", "1"], {
    env: toolEnv,
    stdio: "ignore",
  });
}

function readHttpBodyText(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > 4 * 1024 * 1024) {
        reject(new Error("Payload exceeds 4 MiB"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "content-type, authorization, traceparent, tracestate, baggage, x-workspace-id, accept",
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

function sendJson(res, status, payload) {
  const body = `${JSON.stringify(payload)}\n`;
  setCorsHeaders(res);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function listenEphemeral(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function parseTraceparentHeader(raw) {
  if (typeof raw !== "string") return null;
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/i.exec(raw.trim());
  if (!match) return null;
  return {
    traceId: match[1].toLowerCase(),
    parentSpanId: match[2].toLowerCase(),
  };
}

function parseBaggageSessionId(raw) {
  if (typeof raw !== "string") return null;
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (key === "sp.session.id" && val) {
      return decodeURIComponent(val);
    }
  }
  return null;
}

function decodeAttrMap(rawAttrs) {
  const out = {};
  if (!Array.isArray(rawAttrs)) return out;
  for (const kv of rawAttrs) {
    if (!kv || typeof kv.key !== "string" || !kv.value) continue;
    const v = kv.value;
    if (typeof v.stringValue === "string") out[kv.key] = v.stringValue;
    else if (v.intValue !== undefined) out[kv.key] = String(v.intValue);
    else if (v.doubleValue !== undefined) out[kv.key] = String(v.doubleValue);
    else if (typeof v.boolValue === "boolean") out[kv.key] = String(v.boolValue);
  }
  return out;
}

async function startInProcessBlackboxAndBackendStack() {
  const ingestedResourceSpans = [];
  const rawTraceRequests = [];
  const inviteRequests = [];
  const downstreamEmailRequests = [];

  const sinkServer = http.createServer(async (req, res) => {
    setCorsHeaders(res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "POST" && parsedUrl.pathname === "/v1/traces") {
      try {
        const text = await readHttpBodyText(req);
        const parsed = text.trim() ? JSON.parse(text) : {};
        rawTraceRequests.push({
          headers: req.headers,
          body: parsed,
        });
        for (const rs of parsed.resourceSpans ?? []) {
          ingestedResourceSpans.push(rs);
        }
        sendJson(res, 200, { partialSuccess: {} });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    const sessionMatch = /^\/v1\/llm\/sessions\/([^/]+)$/.exec(parsedUrl.pathname);
    if (req.method === "GET" && sessionMatch?.[1]) {
      const requestedSession = decodeURIComponent(sessionMatch[1]);
      const matchingSpans = [];
      for (const rs of ingestedResourceSpans) {
        const resAttrs = decodeAttrMap(rs.resource?.attributes);
        for (const ss of rs.scopeSpans ?? []) {
          for (const sp of ss.spans ?? []) {
            const attrs = decodeAttrMap(sp.attributes);
            const spanSession = attrs["sp.session.id"] ?? attrs["session.id"];
            if (spanSession === requestedSession) {
              matchingSpans.push({
                ...sp,
                resource_attributes: rs.resource?.attributes ?? [],
                service_name: resAttrs["service.name"] ?? attrs["service.name"],
                session_id: spanSession,
              });
            }
          }
        }
      }
      sendJson(res, 200, {
        session_id: requestedSession,
        spans: matchingSpans,
      });
      return;
    }

    const traceMatch = /^\/api\/traces\/([0-9a-fA-F]{32})$/.exec(parsedUrl.pathname);
    if (req.method === "GET" && traceMatch?.[1]) {
      const targetTraceId = traceMatch[1].toLowerCase();
      const filteredResourceSpans = [];
      for (const rs of ingestedResourceSpans) {
        const matchingScopes = [];
        for (const ss of rs.scopeSpans ?? []) {
          const spans = (ss.spans ?? []).filter(
            (sp) => String(sp.traceId ?? "").toLowerCase() === targetTraceId,
          );
          if (spans.length > 0) {
            matchingScopes.push({ ...ss, spans });
          }
        }
        if (matchingScopes.length > 0) {
          filteredResourceSpans.push({
            resource: rs.resource,
            scopeSpans: matchingScopes,
          });
        }
      }
      if (filteredResourceSpans.length === 0) {
        sendJson(res, 404, { error: "Trace not found" });
        return;
      }
      sendJson(res, 200, {
        trace: {
          resourceSpans: filteredResourceSpans,
        },
      });
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  });

  const sinkPort = await listenEphemeral(sinkServer);
  const sinkBaseUrl = `http://127.0.0.1:${sinkPort}`;

  const downstreamServer = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/v1/email/send") {
      const raw = await readHttpBodyText(req);
      const body = raw.trim() ? JSON.parse(raw) : {};
      downstreamEmailRequests.push({ headers: req.headers, body });
      sendJson(res, 200, { ok: true, queued: true });
      return;
    }
    sendJson(res, 404, { ok: false });
  });

  const downstreamPort = await listenEphemeral(downstreamServer);
  const downstreamBaseUrl = `http://127.0.0.1:${downstreamPort}`;

  const backendServer = http.createServer(async (req, res) => {
    setCorsHeaders(res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "POST" && req.url === "/api/invites") {
      const serverStartNs = BigInt(Date.now()) * 1_000_000n;
      const rawBody = await readHttpBodyText(req);
      const body = rawBody.trim() ? JSON.parse(rawBody) : {};

      const parsedTp = parseTraceparentHeader(req.headers.traceparent);
      const baggageSessionId = parseBaggageSessionId(req.headers.baggage);
      const traceId = parsedTp?.traceId ?? randomBytes(16).toString("hex");
      const serverSpanId = randomBytes(8).toString("hex");

      inviteRequests.push({
        headers: req.headers,
        body,
        traceId,
        parentSpanId: parsedTp?.parentSpanId ?? null,
        baggageSessionId,
      });

      const email = typeof body.email === "string" ? body.email.trim() : "";
      const password = typeof body.password === "string" ? body.password : "";
      if (!email || !password) {
        sendJson(res, 400, { ok: false, error: "Email and password required" });
        return;
      }

      const clientStartNs = BigInt(Date.now()) * 1_000_000n;
      const clientSpanId = randomBytes(8).toString("hex");
      const outboundBodyText = JSON.stringify({ to: email });
      const downstreamUrl = `${downstreamBaseUrl}/v1/email/send`;

      const downstreamRes = await fetch(downstreamUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          traceparent: `00-${traceId}-${clientSpanId}-01`,
          ...(req.headers.baggage ? { baggage: String(req.headers.baggage) } : {}),
        },
        body: outboundBodyText,
      });
      const downstreamResText = await downstreamRes.text();
      const clientEndNs = BigInt(Date.now()) * 1_000_000n;
      const serverEndNs = BigInt(Date.now()) * 1_000_000n;

      const sessionAttrs = baggageSessionId
        ? [{ key: "sp.session.id", value: { stringValue: baggageSessionId } }]
        : [];

      await fetch(`${sinkBaseUrl}/v1/traces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resourceSpans: [
            {
              resource: {
                attributes: [
                  { key: "service.name", value: { stringValue: "invite-backend-obi" } },
                ],
              },
              scopeSpans: [
                {
                  scope: { name: "obi-http" },
                  spans: [
                    {
                      traceId,
                      spanId: serverSpanId,
                      ...(parsedTp?.parentSpanId
                        ? { parentSpanId: parsedTp.parentSpanId }
                        : {}),
                      name: "POST /api/invites",
                      kind: 2,
                      startTimeUnixNano: serverStartNs.toString(),
                      endTimeUnixNano: serverEndNs.toString(),
                      attributes: [
                        ...sessionAttrs,
                        { key: "http.request.method", value: { stringValue: "POST" } },
                        { key: "http.route", value: { stringValue: "/api/invites" } },
                        { key: "url.path", value: { stringValue: "/api/invites" } },
                        { key: "http.response.status_code", value: { intValue: "200" } },
                      ],
                    },
                    {
                      traceId,
                      spanId: clientSpanId,
                      parentSpanId: serverSpanId,
                      name: "POST /v1/email/send",
                      kind: 3,
                      startTimeUnixNano: clientStartNs.toString(),
                      endTimeUnixNano: clientEndNs.toString(),
                      attributes: [
                        ...sessionAttrs,
                        { key: "http.request.method", value: { stringValue: "POST" } },
                        { key: "url.full", value: { stringValue: downstreamUrl } },
                        {
                          key: "http.response.status_code",
                          value: { intValue: String(downstreamRes.status) },
                        },
                        { key: "http.request.body", value: { stringValue: outboundBodyText } },
                        {
                          key: "http.response.body",
                          value: { stringValue: downstreamResText.trim() },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        }),
      });

      sendJson(res, 200, { ok: true, invited: email });
      return;
    }

    sendJson(res, 404, { ok: false, error: "Not found" });
  });

  const backendPort = await listenEphemeral(backendServer);
  const backendBaseUrl = `http://127.0.0.1:${backendPort}`;

  return {
    sinkPort,
    sinkBaseUrl,
    backendPort,
    backendBaseUrl,
    downstreamPort,
    getSnapshot() {
      return {
        ingestedResourceSpans: [...ingestedResourceSpans],
        rawTraceRequests: [...rawTraceRequests],
        inviteRequests: [...inviteRequests],
        downstreamEmailRequests: [...downstreamEmailRequests],
      };
    },
    async close() {
      await Promise.all([
        closeServer(backendServer),
        closeServer(downstreamServer),
        closeServer(sinkServer),
      ]);
    },
  };
}

async function buildRnWebViewApk(workDir) {
  assert.ok(
    fs.existsSync(distEntryPath),
    `Compiled @softprobe/react-native missing at ${distEntryPath}. Run npm run build first.`,
  );

  const sdkRoot = resolveSdkRoot();
  const buildToolsDir = path.join(sdkRoot, "build-tools", "35.0.0");
  const androidJar = path.join(sdkRoot, "platforms", "android-35", "android.jar");
  for (const reqPath of [
    path.join(buildToolsDir, "aapt2"),
    path.join(buildToolsDir, "d8"),
    path.join(buildToolsDir, "zipalign"),
    path.join(buildToolsDir, "apksigner"),
    androidJar,
  ]) {
    assert.ok(fs.existsSync(reqPath), `Missing Android SDK tool at ${reqPath}`);
  }

  const bundleEntryPath = path.join(workDir, "rn-webview-entry.mjs");
  fs.writeFileSync(
    bundleEntryPath,
    `import { initSoftprobeReactNative } from ${JSON.stringify(distEntryPath)};

const launchArguments =
  typeof window.__SP_LAUNCH_ARGS__ === "object" && window.__SP_LAUNCH_ARGS__ !== null
    ? window.__SP_LAUNCH_ARGS__
    : {};

const emailInput = document.getElementById("email_input");
const passwordInput = document.getElementById("password_input");
const sendButton = document.getElementById("send_invite_button");
const statusBanner = document.getElementById("status_banner");
const sessionChip = document.getElementById("session_chip");

const softprobe = initSoftprobeReactNative({
  endpoint: launchArguments.otlp_endpoint || "http://127.0.0.1:4318",
  platform: "android",
  serviceName: "rn-invite-avd-app",
  launchArguments,
  initialRoute: "TeamInvite",
  quietMs: 50,
  secretSlots: {
    password_input: "INVITE_PASSWORD",
  },
  observeAnchors: () => {
    const text = (statusBanner.textContent || "").trim();
    if (!text || text === "Ready to invite" || text === "Sending invite...") {
      return [];
    }
    return [{ role: "status", testId: "status_banner", text }];
  },
});

sessionChip.textContent = "Session: " + softprobe.sessionId;
softprobe.actions.onNavigationRouteChange("TeamInvite", { trigger: "load" });

let lastRecordedEmail = "";
let lastRecordedPassword = "";

function flushEmailIfChanged() {
  const val = (emailInput.value || "").trim();
  if (val && val !== lastRecordedEmail) {
    lastRecordedEmail = val;
    softprobe.actions.recordFill(
      {
        testId: "email_input",
        accessibilityId: "email_input",
        role: "textbox",
        name: "Teammate email",
        label: "Teammate email",
      },
      val,
    );
  }
}

function flushPasswordIfChanged() {
  const val = passwordInput.value || "";
  if (val && val !== lastRecordedPassword) {
    lastRecordedPassword = val;
    softprobe.actions.recordFill(
      {
        testId: "password_input",
        accessibilityId: "password_input",
        role: "textbox",
        name: "Invite password",
        label: "Invite password",
        inputPurpose: "password",
      },
      val,
      { secureTextEntry: true },
    );
  }
}

emailInput.addEventListener("blur", flushEmailIfChanged);
emailInput.addEventListener("change", flushEmailIfChanged);
passwordInput.addEventListener("blur", flushPasswordIfChanged);
passwordInput.addEventListener("change", flushPasswordIfChanged);

sendButton.addEventListener("click", async () => {
  flushEmailIfChanged();
  flushPasswordIfChanged();
  await softprobe.actions.waitForIdle();

  const rect = sendButton.getBoundingClientRect();
  softprobe.actions.recordTap({
    testId: "send_invite_button",
    accessibilityId: "send_invite_button",
    role: "button",
    name: "Send invite",
    rect: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height)),
    },
  });

  const email = (emailInput.value || "").trim();
  const password = passwordInput.value || "";
  sendButton.disabled = true;
  statusBanner.style.background = "#E2E8F0";
  statusBanner.style.color = "#0F172A";
  statusBanner.textContent = "Sending invite...";

  try {
    const response = await fetch("/api/invites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (response.ok) {
      statusBanner.style.background = "#DCFCE7";
      statusBanner.style.color = "#14532D";
      statusBanner.textContent = "Invitation queued for " + email;
    } else {
      statusBanner.style.background = "#FEE2E2";
      statusBanner.style.color = "#7F1D1D";
      statusBanner.textContent = "Error: HTTP " + response.status;
    }
  } catch (err) {
    statusBanner.style.background = "#FEE2E2";
    statusBanner.style.color = "#7F1D1D";
    statusBanner.textContent = "Error: " + (err && err.message ? err.message : String(err));
  } finally {
    sendButton.disabled = false;
    await softprobe.actions.waitForIdle();
    await softprobe.flush();
  }
});

window.__SOFTPROBE_RN__ = softprobe;
`,
  );

  const bundledJsResult = await esbuildBuild({
    entryPoints: [bundleEntryPath],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2020",
    write: false,
  });
  const bundledJs = bundledJsResult.outputFiles[0].text;

  const srcMain = path.join(workDir, "src", "main");
  const javaPkgDir = path.join(srcMain, "java", "com", "softprobe", "rn", "invite");
  const resValuesDir = path.join(srcMain, "res", "values");
  const assetsDir = path.join(srcMain, "assets");
  fs.mkdirSync(javaPkgDir, { recursive: true });
  fs.mkdirSync(resValuesDir, { recursive: true });
  fs.mkdirSync(assetsDir, { recursive: true });

  fs.writeFileSync(
    path.join(resValuesDir, "strings.xml"),
    `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="app_name">Team Invite RN</string>
</resources>
`,
  );

  fs.writeFileSync(
    path.join(srcMain, "AndroidManifest.xml"),
    `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="${appPackage}">
    <uses-permission android:name="android.permission.INTERNET" />
    <application
        android:label="@string/app_name"
        android:usesCleartextTraffic="true"
        android:theme="@android:style/Theme.DeviceDefault.Light.NoActionBar">
        <activity
            android:name=".RnWebViewInviteActivity"
            android:exported="true"
            android:launchMode="singleTop"
            android:windowSoftInputMode="adjustResize">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
`,
  );

  const escapedScript = bundledJs.replace(/<\/script>/gi, "<\\/script>");
  fs.writeFileSync(
    path.join(assetsDir, "index.html"),
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
  <title>Team Invite</title>
  <style>
    * { box-sizing: border-box; font-family: sans-serif; }
    body {
      margin: 0;
      padding: 28px 20px;
      background: #F8FAFC;
      color: #0F172A;
    }
    .card {
      background: #FFFFFF;
      border: 1px solid #CBD5E1;
      border-radius: 16px;
      padding: 24px 20px;
      box-shadow: 0 4px 12px rgba(15, 23, 42, 0.06);
    }
    h1 {
      margin: 0 0 6px 0;
      font-size: 24px;
      font-weight: 700;
      color: #0F172A;
    }
    .chip {
      display: inline-block;
      margin-bottom: 18px;
      padding: 4px 10px;
      border-radius: 999px;
      background: #E0F2FE;
      color: #0369A1;
      font-size: 12px;
      font-weight: 600;
    }
    label {
      display: block;
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 6px;
      color: #334155;
    }
    input {
      width: 100%;
      padding: 14px 12px;
      margin-bottom: 16px;
      font-size: 16px;
      border: 2px solid #94A3B8;
      border-radius: 10px;
      background: #FFFFFF;
      color: #0F172A;
    }
    button {
      width: 100%;
      padding: 15px 16px;
      font-size: 17px;
      font-weight: 700;
      border: none;
      border-radius: 10px;
      background: #2563EB;
      color: #FFFFFF;
      margin-top: 4px;
    }
    button:disabled {
      background: #93C5FD;
    }
    #status_banner {
      margin-top: 18px;
      padding: 14px 12px;
      border-radius: 10px;
      background: #F1F5F9;
      color: #334155;
      font-size: 15px;
      font-weight: 600;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>Team Invite</h1>
    <div id="session_chip" class="chip">Session: initializing</div>
    <label for="email_input">Teammate email</label>
    <input id="email_input" name="email_input" type="email" aria-label="Teammate email" placeholder="Teammate email" autocomplete="off" />
    <label for="password_input">Invite password</label>
    <input id="password_input" name="password_input" type="password" aria-label="Invite password" placeholder="Invite password" autocomplete="off" />
    <button id="send_invite_button" type="button" aria-label="Send invite">Send invite</button>
    <div id="status_banner" role="status" aria-live="polite">Ready to invite</div>
  </div>
  <script>${escapedScript}</script>
</body>
</html>
`,
  );

  fs.writeFileSync(
    path.join(javaPkgDir, "RnWebViewInviteActivity.java"),
    `package com.softprobe.rn.invite;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

public final class RnWebViewInviteActivity extends Activity {
    private WebView webView;
    private String launchArgsJson = "{}";
    private String apiBaseUrl = "http://127.0.0.1:18080";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        readLaunchArgs(getIntent());

        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient());
        setContentView(webView);

        String html = loadAssetHtml();
        webView.loadDataWithBaseURL(apiBaseUrl + "/", html, "text/html", "UTF-8", null);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (!hasLaunchConfigExtras(intent)) {
            return;
        }
        setIntent(intent);
        readLaunchArgs(intent);
        if (webView != null) {
            String html = loadAssetHtml();
            webView.loadDataWithBaseURL(apiBaseUrl + "/", html, "text/html", "UTF-8", null);
        }
    }

    private static boolean hasLaunchConfigExtras(Intent intent) {
        if (intent == null || intent.getExtras() == null) {
            return false;
        }
        Bundle extras = intent.getExtras();
        return extras.containsKey("sp_session_id")
            || extras.containsKey("api_base_url")
            || extras.containsKey("otlp_endpoint");
    }

    private void readLaunchArgs(Intent intent) {
        if (!hasLaunchConfigExtras(intent)) {
            return;
        }
        try {
            JSONObject obj = new JSONObject();
            Bundle extras = intent.getExtras();
            for (String key : extras.keySet()) {
                Object val = extras.get(key);
                if (val != null) {
                    obj.put(key, String.valueOf(val));
                }
            }
            String rawBase = obj.optString("api_base_url", "").trim();
            if (!rawBase.isEmpty()) {
                while (rawBase.endsWith("/")) {
                    rawBase = rawBase.substring(0, rawBase.length() - 1);
                }
                apiBaseUrl = rawBase;
            }
            launchArgsJson = obj.toString();
        } catch (Exception ignored) {
            launchArgsJson = "{}";
        }
    }

    private String loadAssetHtml() {
        try (InputStream in = getAssets().open("index.html");
             ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) != -1) {
                out.write(buf, 0, n);
            }
            String rawHtml = new String(out.toByteArray(), StandardCharsets.UTF_8);
            String bootstrap = "<script>window.__SP_LAUNCH_ARGS__ = " + launchArgsJson + ";</script>";
            return rawHtml.replace("</head>", bootstrap + "</head>");
        } catch (Exception ex) {
            return "<html><body>Failed to load index.html: " + ex.getMessage() + "</body></html>";
        }
    }
}
`,
  );

  const buildInterm = path.join(workDir, "intermediaries");
  const genDir = path.join(buildInterm, "gen");
  const classesDir = path.join(buildInterm, "classes");
  const dexDir = path.join(buildInterm, "dex");
  fs.mkdirSync(genDir, { recursive: true });
  fs.mkdirSync(classesDir, { recursive: true });
  fs.mkdirSync(dexDir, { recursive: true });

  const resZip = path.join(buildInterm, "res.zip");
  const unalignedApk = path.join(buildInterm, "unaligned.apk");
  const alignedApk = path.join(buildInterm, "aligned.apk");
  const outApk = path.join(workDir, "rn-webview-invite.apk");

  runCmd(path.join(buildToolsDir, "aapt2"), [
    "compile",
    "--dir",
    path.join(srcMain, "res"),
    "-o",
    resZip,
  ]);

  runCmd(path.join(buildToolsDir, "aapt2"), [
    "link",
    "-I",
    androidJar,
    "--manifest",
    path.join(srcMain, "AndroidManifest.xml"),
    "-A",
    assetsDir,
    "--java",
    genDir,
    "--min-sdk-version",
    "26",
    "--target-sdk-version",
    "35",
    "-o",
    unalignedApk,
    resZip,
  ]);

  const javaFiles = [
    path.join(javaPkgDir, "RnWebViewInviteActivity.java"),
    path.join(genDir, "com", "softprobe", "rn", "invite", "R.java"),
  ];
  runCmd("javac", [
    "--release",
    "17",
    "-encoding",
    "UTF-8",
    "-cp",
    androidJar,
    "-d",
    classesDir,
    ...javaFiles,
  ]);

  const classesJar = path.join(buildInterm, "classes.jar");
  runCmd("jar", ["--create", "--file", classesJar, "-C", classesDir, "."]);

  runCmd(path.join(buildToolsDir, "d8"), [
    "--lib",
    androidJar,
    "--min-api",
    "26",
    "--output",
    dexDir,
    classesJar,
  ]);

  runCmd("python3", [
    "-c",
    `import sys, zipfile
with zipfile.ZipFile(sys.argv[1], "a") as zf:
    zf.write(sys.argv[2], arcname="classes.dex", compress_type=zipfile.ZIP_DEFLATED)`,
    unalignedApk,
    path.join(dexDir, "classes.dex"),
  ]);

  runCmd(path.join(buildToolsDir, "zipalign"), ["-f", "-p", "4", unalignedApk, alignedApk]);

  const keystorePath = path.join(workDir, "debug.keystore");
  runCmd("keytool", [
    "-genkeypair",
    "-keystore",
    keystorePath,
    "-storepass",
    "android",
    "-keypass",
    "android",
    "-alias",
    "androiddebugkey",
    "-keyalg",
    "RSA",
    "-keysize",
    "2048",
    "-validity",
    "10000",
    "-dname",
    "CN=Android Debug,O=Android,C=US",
  ]);

  runCmd(path.join(buildToolsDir, "apksigner"), [
    "sign",
    "--ks",
    keystorePath,
    "--ks-key-alias",
    "androiddebugkey",
    "--ks-pass",
    "pass:android",
    "--key-pass",
    "pass:android",
    "--out",
    outApk,
    alignedApk,
  ]);

  return outApk;
}

function createFrameSampler(serial, framesDir) {
  fs.mkdirSync(framesDir, { recursive: true });
  let active = true;
  let frameIndex = 0;

  const captureOne = () => {
    const outFile = path.join(framesDir, `frame-${String(frameIndex).padStart(5, "0")}.png`);
    const res = spawnSync("adb", ["-s", serial, "exec-out", "screencap", "-p"], {
      env: toolEnv,
      maxBuffer: 32 * 1024 * 1024,
    });
    if (res.status === 0 && res.stdout && res.stdout.length > 1024) {
      fs.writeFileSync(outFile, res.stdout);
      frameIndex += 1;
    }
  };

  const loopPromise = (async () => {
    while (active) {
      captureOne();
      await delay(140);
    }
    captureOne();
  })();

  return {
    captureNow: captureOne,
    getFrameCount: () => frameIndex,
    async stopAndEncode(outputMp4Path) {
      active = false;
      await loopPromise;
      while (frameIndex < 24) {
        captureOne();
      }
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
    env: toolEnv,
    stdio: "ignore",
  });
  const child = spawn(
    "adb",
    [
      "-s",
      serial,
      "shell",
      "screenrecord",
      "--bit-rate",
      "4000000",
      "--size",
      "720x1600",
      remotePath,
    ],
    { env: toolEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
  return {
    async stopAndPull(localOutPath) {
      if (child.exitCode === null) {
        spawnSync("adb", ["-s", serial, "shell", "pkill", "-SIGINT", "screenrecord"], {
          env: toolEnv,
          stdio: "ignore",
        });
        await pollUntil("screenrecord flush", () => child.exitCode !== null, {
          timeoutMs: 8_000,
          intervalMs: 200,
        }).catch(() => {
          child.kill("SIGTERM");
        });
      }
      const statOut = spawnSync("adb", ["-s", serial, "shell", "wc", "-c", remotePath], {
        env: toolEnv,
        encoding: "utf8",
      });
      const remoteBytes = Number.parseInt(
        (statOut.stdout ?? "").trim().split(/\s+/)[0] ?? "0",
        10,
      );
      if (!Number.isFinite(remoteBytes) || remoteBytes <= 10 * 1024) {
        return false;
      }
      const tmpMp4 = `${localOutPath}.sr.${process.pid}.mp4`;
      const pullRes = spawnSync("adb", ["-s", serial, "pull", remotePath, tmpMp4], {
        env: toolEnv,
        stdio: "ignore",
      });
      spawnSync("adb", ["-s", serial, "shell", "rm", "-f", remotePath], {
        env: toolEnv,
        stdio: "ignore",
      });
      if (pullRes.status !== 0 || !fs.existsSync(tmpMp4)) {
        return false;
      }
      try {
        verifyMp4Artifact(tmpMp4);
        fs.renameSync(tmpMp4, localOutPath);
        return true;
      } catch {
        fs.rmSync(tmpMp4, { force: true });
        return false;
      }
    },
  };
}

function verifyMp4Artifact(mp4Path) {
  assert.ok(fs.existsSync(mp4Path), `Missing MP4 artifact at ${mp4Path}`);
  const stat = fs.statSync(mp4Path);
  assert.ok(
    stat.size > 10 * 1024,
    `Expected MP4 size > 10240 bytes, got ${stat.size} bytes`,
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
  assert.ok(frameCount >= 20, `Expected nb_read_frames >= 20, got ${frameCount}`);

  const sampleRgb = execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
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
    { env: toolEnv, maxBuffer: 4 * 1024 * 1024 },
  );
  assert.equal(sampleRgb.length, 64 * 64 * 3, "Unexpected RGB frame byte length");

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
    `Decoded video frame appears blank (lumaSpread ${lumaSpread} <= 20)`,
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

function runAgentDevice(stateDir, serial, subcommandArgs) {
  const args = [
    ...subcommandArgs,
    "--platform",
    "android",
    "--serial",
    serial,
    "--json",
  ];
  const raw = execFileSync("agent-device", args, {
    encoding: "utf8",
    env: {
      ...toolEnv,
      AGENT_DEVICE_STATE_DIR: stateDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(raw);
}

function findNodeRefInSnapshot(snapshotObj, predicate) {
  const queue = [snapshotObj];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== "object") continue;
    if (Array.isArray(current)) {
      for (const item of current) queue.push(item);
      continue;
    }
    if (predicate(current) && typeof current.ref === "string" && current.ref) {
      return current.ref.startsWith("@") ? current.ref : `@${current.ref}`;
    }
    for (const val of Object.values(current)) {
      if (val && typeof val === "object") {
        queue.push(val);
      }
    }
  }
  return null;
}

function resolveInteractiveSelector(snapObj, idHint, textHint) {
  const byRef = findNodeRefInSnapshot(snapObj, (node) => {
    const hay = JSON.stringify({
      id: node.id ?? node.resourceId ?? "",
      label: node.label ?? node.name ?? node.text ?? node.placeholder ?? "",
      role: node.role ?? node.type ?? node.className ?? "",
    }).toLowerCase();
    return (
      (idHint && hay.includes(idHint.toLowerCase())) ||
      (textHint && hay.includes(textHint.toLowerCase()))
    );
  });
  if (byRef) return byRef;
  return `id="${idHint}"`;
}

async function main() {
  const explicitTarget = (
    process.env.SP_ANDROID_ADB_TARGET ??
    process.env.ANDROID_SERIAL ??
    ""
  ).trim();
  const videoOutPath = path.resolve(
    (process.env.SP_AVD_VIDEO_OUT ?? "").trim() ||
      path.join(pkgRoot, ".audit", "videos", "phase3-path2-rn-session.mp4"),
  );
  fs.mkdirSync(path.dirname(videoOutPath), { recursive: true });

  const tempWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), "sp-rn-avd-live-"));
  const apkBuildDir = path.join(tempWorkDir, "apk-build");
  const agentStateDir = path.join(tempWorkDir, "agent-device-state");
  const framesDir = path.join(tempWorkDir, "frames");
  fs.mkdirSync(apkBuildDir, { recursive: true });
  fs.mkdirSync(agentStateDir, { recursive: true });

  const serial = await resolveReadyDevice(explicitTarget);
  await waitForAndroidBoot(serial);

  const apkPath = await buildRnWebViewApk(apkBuildDir);
  assert.ok(fs.existsSync(apkPath), `Expected built APK at ${apkPath}`);

  spawnSync("adb", ["-s", serial, "uninstall", appPackage], {
    env: toolEnv,
    stdio: "ignore",
  });
  runAdb(serial, ["install", "--no-incremental", "-r", apkPath]);
  spawnSync("adb", ["-s", serial, "shell", "am", "force-stop", appPackage], {
    env: toolEnv,
    stdio: "ignore",
  });
  spawnSync("adb", ["-s", serial, "shell", "pm", "clear", appPackage], {
    env: toolEnv,
    stdio: "ignore",
  });

  const stack = await startInProcessBlackboxAndBackendStack();
  const reversedPorts = [];
  let sampler = null;
  let screenrec = null;
  const abortController = new AbortController();

  try {
    runAdb(serial, ["reverse", `tcp:${stack.backendPort}`, `tcp:${stack.backendPort}`]);
    reversedPorts.push(stack.backendPort);
    runAdb(serial, ["reverse", `tcp:${stack.sinkPort}`, `tcp:${stack.sinkPort}`]);
    reversedPorts.push(stack.sinkPort);

    const remoteVideoPath = `/sdcard/Download/sp-rn-path2-${process.pid}.mp4`;
    screenrec = startDeviceScreenrecord(serial, remoteVideoPath);
    sampler = createFrameSampler(serial, framesDir);

    runAdb(serial, [
      "shell",
      "am",
      "start",
      "-W",
      "-S",
      "-n",
      appActivity,
      "--es",
      "sp_session_id",
      targetSessionId,
      "--es",
      "api_base_url",
      `http://127.0.0.1:${stack.backendPort}`,
      "--es",
      "otlp_endpoint",
      `http://127.0.0.1:${stack.sinkPort}`,
    ]);

    const openRes = runAgentDevice(agentStateDir, serial, [
      "open",
      appPackage,
      "--foreground",
    ]);
    assert.ok(openRes, "agent-device open returned empty response");

    const readySnap = await pollUntil(
      "WebView Team Invite interactive form",
      () => {
        const snap = runAgentDevice(agentStateDir, serial, ["snapshot", "-i"]);
        const text = JSON.stringify(snap);
        return text.includes("Send invite") || text.includes("email_input") || text.includes("Teammate email")
          ? snap
          : null;
      },
      { timeoutMs: 25_000, intervalMs: 400 },
    );
    sampler.captureNow();

    const emailSelector = resolveInteractiveSelector(
      readySnap,
      "email_input",
      "Teammate email",
    );
    runAgentDevice(agentStateDir, serial, [
      "fill",
      emailSelector,
      "ada@acme.com",
      "--settle",
    ]);
    sampler.captureNow();

    const snapAfterEmail = runAgentDevice(agentStateDir, serial, ["snapshot", "-i"]);
    const passwordSelector = resolveInteractiveSelector(
      snapAfterEmail,
      "password_input",
      "Invite password",
    );
    runAgentDevice(agentStateDir, serial, [
      "fill",
      passwordSelector,
      rawSecretPassword,
      "--settle",
    ]);
    sampler.captureNow();

    spawnSync("adb", ["-s", serial, "shell", "input", "keyevent", "KEYCODE_BACK"], {
      env: toolEnv,
      stdio: "ignore",
    });
    await delay(250);

    const snapBeforeTap = runAgentDevice(agentStateDir, serial, ["snapshot", "-i"]);
    const buttonSelector = resolveInteractiveSelector(
      snapBeforeTap,
      "send_invite_button",
      "Send invite",
    );
    runAgentDevice(agentStateDir, serial, ["press", buttonSelector, "--settle"]);
    sampler.captureNow();

    await pollUntil(
      'on-screen banner "Invitation queued for ada@acme.com"',
      () => {
        const snap = runAgentDevice(agentStateDir, serial, ["snapshot", "--force-full"]);
        return JSON.stringify(snap).includes("Invitation queued for ada@acme.com");
      },
      { timeoutMs: 20_000, intervalMs: 350 },
    );
    sampler.captureNow();
    await delay(500);
    sampler.captureNow();

    const triggerSource = createBlackboxSessionTriggerSource({
      endpoint: stack.sinkBaseUrl,
      sessionId: targetSessionId,
    });
    const sink = new BlackboxSink({
      endpoint: stack.sinkBaseUrl,
    });
    const trace = createTraceScope({
      triggerSource,
      resolveSink: () => sink,
      pollingDefaults: {
        pollTimeoutMs: 15_000,
        pollIntervalMs: 200,
        settleMs: 100,
      },
      signal: abortController.signal,
    });

    const outboundCall = await trace.outboundHttp({
      triggeredBy: { method: "POST", path: "/api/invites" },
      method: "POST",
      url: "/v1/email/send",
      status: 200,
    });
    assert.deepEqual(outboundCall.request.json, { to: "ada@acme.com" });

    await pollUntil(
      "ingested softprobe.ui.action click span with causedTraces",
      async () => {
        const sessionRes = await fetch(
          `${stack.sinkBaseUrl}/v1/llm/sessions/${encodeURIComponent(targetSessionId)}`,
        );
        const sessionJson = await sessionRes.json();
        const uiSpans = (sessionJson.spans ?? []).filter(
          (sp) => sp.name === "softprobe.ui.action",
        );
        if (uiSpans.length < 3) return null;
        return sessionJson;
      },
      { timeoutMs: 10_000, intervalMs: 200 },
    );

    const snapshot = stack.getSnapshot();
    assert.equal(snapshot.inviteRequests.length, 1);
    assert.equal(
      snapshot.inviteRequests[0].baggageSessionId,
      targetSessionId,
      "Expected W3C baggage sp.session.id minted inside Android WebView",
    );
    assert.ok(
      snapshot.inviteRequests[0].parentSpanId,
      "Expected W3C traceparent minted inside Android WebView",
    );

    const allOtlpSerialized = JSON.stringify(snapshot.ingestedResourceSpans);
    assert.ok(
      !allOtlpSerialized.includes(rawSecretPassword),
      "Raw password leaked into ingested OTLP spans",
    );

    const sessionRes = await fetch(
      `${stack.sinkBaseUrl}/v1/llm/sessions/${encodeURIComponent(targetSessionId)}`,
    );
    const sessionEnvelope = await sessionRes.json();
    const traceId = snapshot.inviteRequests[0].traceId;
    const traceRes = await fetch(`${stack.sinkBaseUrl}/api/traces/${traceId}`);
    const traceEnvelope = await traceRes.json();

    const bundle = extractSessionBundleFromSpans(sessionEnvelope, {
      sessionId: targetSessionId,
      tracesByTraceId: { [traceId]: traceEnvelope },
    });

    assert.equal(bundle.sessionId, targetSessionId);
    assert.deepEqual(bundle.secretSlots, ["INVITE_PASSWORD"]);
    assert.ok(bundle.outboundAssertionCount >= 1);

    const actions = bundle.steps.map((s) => s.action);
    for (const act of actions) {
      assert.equal(act.captureSource, "otel_sdk");
      assert.equal(act.platform, "android");
    }

    const secretFill = actions.find(
      (a) => a.verb.name === "fill" && a.verb.value.kind === "secret",
    );
    assert.ok(secretFill, "Expected redacted secret fill action in session bundle");
    assert.deepEqual(secretFill.verb.value, {
      kind: "secret",
      slot: "INVITE_PASSWORD",
    });

    const tapAction = actions.find((a) => a.verb.name === "click");
    assert.ok(tapAction, "Expected tap action on Send invite button");
    assert.ok(
      tapAction.causedTraces.some((ct) => ct.traceId === traceId && ct.status === 200),
      "Expected tap action causedTraces to include POST /api/invites traceId",
    );

    while (sampler.getFrameCount() < 24) {
      sampler.captureNow();
      await delay(100);
    }

    const usedScreenrecord = await screenrec.stopAndPull(videoOutPath);
    if (!usedScreenrecord) {
      await sampler.stopAndEncode(videoOutPath);
    } else {
      await sampler.stopAndEncode(path.join(tempWorkDir, "discard-fallback.mp4"));
    }

    const videoMeta = verifyMp4Artifact(videoOutPath);
    process.stdout.write(
      `[rn-avd-live] PASS serial=${serial} session=${targetSessionId} traceId=${traceId} uiActions=${actions.length} video=${videoOutPath} source=${usedScreenrecord ? "screenrecord" : "screencap-x264"} bytes=${videoMeta.bytes} ${videoMeta.width}x${videoMeta.height} frames=${videoMeta.frames} durationSec=${videoMeta.durationSec} lumaSpread=${videoMeta.lumaSpread}\n`,
    );
  } finally {
    abortController.abort();
    try {
      runAgentDevice(agentStateDir, serial, ["close"]);
    } catch {}
    for (const port of reversedPorts) {
      spawnSync("adb", ["-s", serial, "reverse", "--remove", `tcp:${port}`], {
        env: toolEnv,
        stdio: "ignore",
      });
    }
    await stack.close();
    fs.rmSync(tempWorkDir, { recursive: true, force: true });
  }
}

await main();
