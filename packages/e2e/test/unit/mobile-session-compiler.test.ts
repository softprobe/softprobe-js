import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCompileSessionCli } from "../../src/bin/compile-session.js";
import { softprobeReporter } from "../../src/mobile.js";
import {
  buildE2ECacheKeyAndHash,
  compileSessionToMaestro,
  compileSessionToMobileE2E,
  extractSessionBundleFromSpans,
  formatE2ETestId,
  type RecordedSemanticAction,
} from "../../src/session-compiler.js";

const INVITE_TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const HOLD_TRACE_ID = "abcdef0123456789abcdef0123456789";

function createHostAgentAndroidSessionEnvelope() {
  const actions: RecordedSemanticAction[] = [
    {
      schemaVersion: "sp-ui-action-1",
      actionIndex: 0,
      timestampMs: 1700000200000,
      startPath: "/com.softprobe.fixture.invite",
      endPath: "/com.softprobe.fixture.invite",
      viewport: { width: 360, height: 800 },
      platform: "android",
      captureSource: "host_agent",
      verb: {
        name: "fill",
        target: {
          testId: "com.softprobe.fixture.invite:id/email_input",
          accessibilityId: "com.softprobe.fixture.invite:id/email_input",
          role: "textbox",
          name: "Teammate email",
          placeholder: "Teammate email",
          interactive: true,
        },
        value: { kind: "literal", value: "ada@acme.com" },
        replace: true,
      },
      causedTraces: [],
      endAnchors: [],
      goneAnchors: [],
      settleMs: 80,
    },
    {
      schemaVersion: "sp-ui-action-1",
      actionIndex: 1,
      timestampMs: 1700000201000,
      startPath: "/com.softprobe.fixture.invite",
      endPath: "/com.softprobe.fixture.invite",
      viewport: { width: 360, height: 800 },
      platform: "android",
      captureSource: "host_agent",
      verb: {
        name: "fill",
        target: {
          testId: "com.softprobe.fixture.invite:id/password_input",
          accessibilityId: "com.softprobe.fixture.invite:id/password_input",
          role: "textbox",
          name: "Admin password",
          placeholder: "Admin password",
          inputPurpose: "password",
          interactive: true,
        },
        value: { kind: "secret", slot: "ADMIN_PASSWORD" },
        replace: true,
      },
      causedTraces: [],
      endAnchors: [],
      goneAnchors: [],
      settleMs: 90,
    },
    {
      schemaVersion: "sp-ui-action-1",
      actionIndex: 2,
      timestampMs: 1700000202000,
      startPath: "/com.softprobe.fixture.invite",
      endPath: "/com.softprobe.fixture.invite",
      viewport: { width: 360, height: 800 },
      platform: "android",
      captureSource: "host_agent",
      verb: {
        name: "click",
        target: {
          testId: "com.softprobe.fixture.invite:id/send_invite_button",
          accessibilityId: "com.softprobe.fixture.invite:id/send_invite_button",
          role: "button",
          name: "Send invite",
          text: "Send invite",
          interactive: true,
        },
        point: { x: 180, y: 310 },
      },
      causedTraces: [
        {
          traceId: INVITE_TRACE_ID,
          spanId: "1111111111111111",
          method: "POST",
          url: "http://127.0.0.1:18088/api/invites",
          status: 200,
        },
      ],
      endAnchors: [
        {
          testId: "com.softprobe.fixture.invite:id/status_banner",
          accessibilityId: "com.softprobe.fixture.invite:id/status_banner",
          role: "text",
          name: "Invitation queued for ada@acme.com",
          text: "Invitation queued for ada@acme.com",
        },
        {
          testId: "com.softprobe.fixture.invite:id/email_input",
          accessibilityId: "com.softprobe.fixture.invite:id/email_input",
          role: "textbox",
          name: "Teammate email",
          text: "ada@acme.com",
        },
      ],
      goneAnchors: [
        {
          testId: "com.softprobe.fixture.invite:id/status_banner",
          accessibilityId: "com.softprobe.fixture.invite:id/status_banner",
          role: "text",
        },
      ],
      settleMs: 240,
    },
  ];

  return {
    session_id: "sess_android_host_01",
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "softprobe-mobile-host" } },
            { key: "sp.capture.source", value: { stringValue: "host_agent" } },
            { key: "sp.platform", value: { stringValue: "android" } },
          ],
        },
        scopeSpans: [
          {
            spans: actions.map((act, idx) => ({
              traceId: `0000000000000000000000000000010${idx}`,
              spanId: `000000000000010${idx}`,
              name: "softprobe.ui.action",
              kind: 1,
              startTimeUnixNano: String(BigInt(act.timestampMs) * 1_000_000n),
              endTimeUnixNano: String(BigInt(act.timestampMs + act.settleMs) * 1_000_000n),
              attributes: [
                { key: "sp.observation.type", value: { stringValue: "ui_action" } },
                { key: "sp.ui.action.schema", value: { stringValue: "sp-ui-action-1" } },
                { key: "sp.ui.action.index", value: { intValue: act.actionIndex } },
                { key: "sp.ui.action.verb", value: { stringValue: act.verb.name } },
                { key: "sp.ui.action.platform", value: { stringValue: "android" } },
                { key: "sp.ui.action.capture_source", value: { stringValue: "host_agent" } },
                {
                  key: "sp.ui.action.payload",
                  value: { stringValue: `sp.json:${JSON.stringify(act)}` },
                },
                { key: "sp.session.id", value: { stringValue: "sess_android_host_01" } },
              ],
            })),
          },
        ],
      },
    ],
    tracesByTraceId: {
      [INVITE_TRACE_ID]: {
        resourceSpans: [
          {
            resource: {
              attributes: [
                { key: "service.name", value: { stringValue: "invite-otel-service" } },
              ],
            },
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: INVITE_TRACE_ID,
                    spanId: "2222222222222222",
                    parentSpanId: "1111111111111111",
                    name: "POST /api/invites",
                    kind: 2,
                    startTimeUnixNano: "1700000202010000000",
                    endTimeUnixNano: "1700000202180000000",
                    attributes: [
                      { key: "http.request.method", value: { stringValue: "POST" } },
                      { key: "http.route", value: { stringValue: "/api/invites" } },
                      { key: "url.path", value: { stringValue: "/api/invites" } },
                      { key: "http.response.status_code", value: { intValue: 200 } },
                    ],
                  },
                  {
                    traceId: INVITE_TRACE_ID,
                    spanId: "3333333333333333",
                    parentSpanId: "2222222222222222",
                    name: "POST /v1/email/send",
                    kind: 3,
                    startTimeUnixNano: "1700000202030000000",
                    endTimeUnixNano: "1700000202150000000",
                    attributes: [
                      { key: "http.request.method", value: { stringValue: "POST" } },
                      {
                        key: "url.full",
                        value: { stringValue: "http://127.0.0.1:19090/v1/email/send" },
                      },
                      {
                        key: "http.request.body",
                        value: { stringValue: JSON.stringify({ to: "ada@acme.com" }) },
                      },
                      { key: "http.response.status_code", value: { intValue: 200 } },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    },
  };
}

function createOtelSdkIosSessionEnvelope() {
  const actions: RecordedSemanticAction[] = [
    {
      schemaVersion: "sp-ui-action-1",
      actionIndex: 0,
      timestampMs: 1700000300000,
      startPath: "/flights",
      endPath: "/flights",
      viewport: { width: 393, height: 852 },
      platform: "ios",
      captureSource: "otel_sdk",
      verb: {
        name: "swipe",
        direction: "up",
        target: {
          accessibilityId: "results_list",
          role: "list",
          name: "Results",
        },
        distanceRatio: 0.5,
      },
      causedTraces: [],
      endAnchors: [],
      goneAnchors: [],
      settleMs: 100,
    },
    {
      schemaVersion: "sp-ui-action-1",
      actionIndex: 1,
      timestampMs: 1700000301000,
      startPath: "/flights",
      endPath: "/flights",
      viewport: { width: 393, height: 852 },
      platform: "ios",
      captureSource: "otel_sdk",
      verb: {
        name: "fill",
        target: {
          accessibilityId: "otp_field",
          role: "textbox",
          label: "Verification code",
          inputPurpose: "one-time-code",
        },
        value: { kind: "secret", slot: "OTP_CODE" },
        replace: true,
      },
      causedTraces: [],
      endAnchors: [],
      goneAnchors: [],
      settleMs: 60,
    },
    {
      schemaVersion: "sp-ui-action-1",
      actionIndex: 2,
      timestampMs: 1700000301500,
      startPath: "/flights",
      endPath: "/flights",
      viewport: { width: 393, height: 852 },
      platform: "ios",
      captureSource: "otel_sdk",
      verb: {
        name: "dismissKeyboard",
      },
      causedTraces: [],
      endAnchors: [],
      goneAnchors: [],
      settleMs: 30,
    },
    {
      schemaVersion: "sp-ui-action-1",
      actionIndex: 3,
      timestampMs: 1700000302000,
      startPath: "/flights",
      endPath: "/flights/hold",
      viewport: { width: 393, height: 852 },
      platform: "ios",
      captureSource: "otel_sdk",
      verb: {
        name: "longPress",
        target: {
          accessibilityId: "hold_fare_btn",
          role: "button",
          name: "Hold fare",
        },
        durationMs: 700,
      },
      causedTraces: [
        {
          traceId: HOLD_TRACE_ID,
          spanId: "4444444444444444",
          method: "POST",
          url: "https://api.travel.internal/api/holds",
          status: 201,
        },
      ],
      endAnchors: [
        {
          accessibilityId: "hold_status",
          role: "status",
          name: "Fare held for 24h",
        },
        {
          role: "text",
          text: "2026-11-25T09:00:00Z",
        },
      ],
      goneAnchors: [],
      settleMs: 220,
    },
    {
      schemaVersion: "sp-ui-action-1",
      actionIndex: 4,
      timestampMs: 1700000303000,
      startPath: "/flights/hold",
      endPath: "/flights",
      viewport: { width: 393, height: 852 },
      platform: "ios",
      captureSource: "otel_sdk",
      verb: {
        name: "back",
      },
      causedTraces: [],
      endAnchors: [],
      goneAnchors: [],
      settleMs: 80,
    },
    {
      schemaVersion: "sp-ui-action-1",
      actionIndex: 5,
      timestampMs: 1700000304000,
      startPath: "/flights",
      endPath: "/booking/42",
      viewport: { width: 393, height: 852 },
      platform: "ios",
      captureSource: "otel_sdk",
      verb: {
        name: "openLink",
        url: "softprobe://booking/42",
      },
      causedTraces: [],
      endAnchors: [
        {
          role: "heading",
          name: "Booking #42",
        },
      ],
      goneAnchors: [],
      settleMs: 90,
    },
    {
      schemaVersion: "sp-ui-action-1",
      actionIndex: 6,
      timestampMs: 1700000305000,
      startPath: "/booking/42",
      endPath: "/booking/42",
      viewport: { width: 393, height: 852 },
      platform: "ios",
      captureSource: "otel_sdk",
      verb: {
        name: "scroll",
        direction: "down",
        times: 1,
        spansViewport: 0.75,
      },
      causedTraces: [],
      endAnchors: [],
      goneAnchors: [],
      settleMs: 70,
    },
  ];

  return {
    session_id: "sess_ios_otel_02",
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "travel-rn-ios" } },
            { key: "app.bundle_id", value: { stringValue: "com.softprobe.travel.ios" } },
            { key: "sp.platform", value: { stringValue: "ios" } },
          ],
        },
        scopeSpans: [
          {
            spans: actions.map((act, idx) => ({
              traceId: `0000000000000000000000000000020${idx}`,
              spanId: `000000000000020${idx}`,
              name: "softprobe.ui.action",
              kind: 1,
              startTimeUnixNano: String(BigInt(act.timestampMs) * 1_000_000n),
              endTimeUnixNano: String(BigInt(act.timestampMs + act.settleMs) * 1_000_000n),
              attributes: [
                { key: "sp.observation.type", value: { stringValue: "ui_action" } },
                { key: "sp.ui.action.schema", value: { stringValue: "sp-ui-action-1" } },
                { key: "sp.ui.action.index", value: { intValue: act.actionIndex } },
                { key: "sp.ui.action.verb", value: { stringValue: act.verb.name } },
                { key: "sp.ui.action.platform", value: { stringValue: "ios" } },
                { key: "sp.ui.action.capture_source", value: { stringValue: "otel_sdk" } },
                {
                  key: "sp.ui.action.payload",
                  value: { stringValue: `sp.json:${JSON.stringify(act)}` },
                },
                { key: "sp.session.id", value: { stringValue: "sess_ios_otel_02" } },
              ],
            })),
          },
        ],
      },
    ],
    tracesByTraceId: {
      [HOLD_TRACE_ID]: {
        resourceSpans: [
          {
            resource: {
              attributes: [{ key: "service.name", value: { stringValue: "ota-backend" } }],
            },
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: HOLD_TRACE_ID,
                    spanId: "5555555555555555",
                    parentSpanId: "4444444444444444",
                    name: "POST /api/holds",
                    kind: 2,
                    startTimeUnixNano: "1700000302010000000",
                    endTimeUnixNano: "1700000302190000000",
                    attributes: [
                      { key: "http.request.method", value: { stringValue: "POST" } },
                      { key: "url.path", value: { stringValue: "/api/holds" } },
                      { key: "http.response.status_code", value: { intValue: 201 } },
                    ],
                  },
                  {
                    traceId: HOLD_TRACE_ID,
                    spanId: "6666666666666666",
                    parentSpanId: "5555555555555555",
                    name: "POST /v1/pnr/hold",
                    kind: 3,
                    startTimeUnixNano: "1700000302025000000",
                    endTimeUnixNano: "1700000302160000000",
                    attributes: [
                      { key: "http.request.method", value: { stringValue: "POST" } },
                      {
                        key: "url.full",
                        value: { stringValue: "https://gds.internal/v1/pnr/hold" },
                      },
                      { key: "http.response.status_code", value: { intValue: 201 } },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    },
  };
}

describe("@softprobe/e2e mobile session compiler and CLI", () => {
  it("re-exports softprobeReporter from @softprobe/e2e/mobile", () => {
    expect(typeof softprobeReporter).toBe("function");
  });

  it("compiles host_agent Android sessions to @softprobe/e2e/mobile with matching trace-1 cache key, secret slots, proxy correlation, and trace.outboundHttp", () => {
    const envelope = createHostAgentAndroidSessionEnvelope();
    const bundle = extractSessionBundleFromSpans(envelope);

    expect(bundle.platform).toBe("android");
    expect(bundle.captureSource).toBe("host_agent");
    expect(bundle.appBundleId).toBe("com.softprobe.fixture.invite");
    expect(bundle.secretSlots).toEqual(["ADMIN_PASSWORD"]);
    expect(bundle.outboundAssertionCount).toBe(1);

    const compiled = compileSessionToMobileE2E(bundle, {
      sinkEndpoint: "http://127.0.0.1:19999",
      workspaceId: "ws_mobile_01",
      createdAt: "2026-11-25T09:00:00.000Z",
    });

    expect(compiled.runner).toBe("e2e-mobile");
    expect(compiled.platform).toBe("android");
    expect(compiled.bundleId).toBe("com.softprobe.fixture.invite");
    expect(compiled.files).toHaveLength(2);
    expect(compiled.cacheFiles).toHaveLength(1);

    const testFile = compiled.files.find(
      (f) => f.relativePath === "tests/recorded-session.e2e.ts",
    );
    const configFile = compiled.files.find((f) => f.relativePath === "e2e.config.ts");
    expect(testFile).toBeDefined();
    expect(configFile).toBeDefined();

    expect(testFile!.content).toContain(`from "@softprobe/e2e/mobile";`);
    expect(testFile!.content).toContain(`await app.open();`);
    expect(testFile!.content).toContain(
      `params: { "admin_password": secrets.get("ADMIN_PASSWORD") }`,
    );
    expect(testFile!.content).toContain(
      `await expect(screen.getByText("Invitation queued for ada@acme.com")).toBeVisible();`,
    );
    expect(testFile!.content).toContain(`await trace.outboundHttp({`);
    expect(testFile!.content).toContain(`triggeredBy: { method: "POST", path: "/api/invites" }`);
    expect(testFile!.content).toContain(
      `expect(outbound_0_0_0.request.json).toMatchObject({ "to": "ada@acme.com" });`,
    );

    expect(configFile!.content).toContain(`mobileTools,`);
    expect(configFile!.content).toContain(`softprobeCachedAgent,`);
    expect(configFile!.content).toContain(`softprobeMobile,`);
    expect(configFile!.content).toContain(`softprobeReporter,`);
    expect(configFile!.content).toContain(`platform: "android",`);
    expect(configFile!.content).toContain(
      `device: process.env.SP_ANDROID_ADB_TARGET || process.env.E2E_MOBILE_DEVICE || undefined,`,
    );
    expect(configFile!.content).toContain(`mode: "proxy",`);
    expect(configFile!.content).toContain(
      `upstreamOrigin: process.env.API_UPSTREAM_ORIGIN ?? "http://127.0.0.1:18088",`,
    );
    expect(configFile!.content).toContain(`dir: ".e2e/cache",`);
    expect(configFile!.content).toContain(`mode: "read-only",`);
    expect(configFile!.content).toContain(`SP_SECRET_ADMIN_PASSWORD`);
    expect(configFile!.content).toContain(`bundleId: "com.softprobe.fixture.invite"`);

    const cacheArtifact = compiled.cacheFiles[0]!;
    const cacheJson = JSON.parse(cacheArtifact.content) as {
      readonly schemaVersion: string;
      readonly payload: {
        readonly startPath: string;
        readonly endPath: string;
        readonly truncated?: boolean;
        readonly endAnchors?: ReadonlyArray<{
          readonly role?: string;
          readonly testId?: string;
          readonly value?: string;
        }>;
        readonly goneAnchors?: readonly unknown[];
        readonly actions: ReadonlyArray<{ readonly name: string; readonly secret?: string }>;
        readonly recordedFor: {
          readonly testId: string;
          readonly targetId: string;
          readonly instructionDigest: string;
          readonly paramsDigest: string;
        };
        readonly keyedBy: {
          readonly platform: string;
          readonly engineName: string;
        };
      };
    };

    const expectedTestId = formatE2ETestId("tests/recorded-session.e2e.ts", [
      "Recorded mobile session replay",
      "replays session sess_android_host_01",
    ]);
    const instructionMatch = /await agent\.act\((?<instr>"[^"]+")/.exec(testFile!.content);
    expect(instructionMatch?.groups?.["instr"]).toBeDefined();
    const instruction = JSON.parse(instructionMatch!.groups!["instr"]!) as string;

    const expectedKey = buildE2ECacheKeyAndHash({
      projectId: "softprobe-compiled-e2e-mobile",
      testId: expectedTestId,
      targetId: "android",
      platform: "android",
      engineName: "mobile",
      appIdentity: "com.softprobe.fixture.invite",
      appEnvironment: "test",
      instruction,
      secretSlots: ["ADMIN_PASSWORD"],
      callIndex: 0,
    });

    expect(cacheArtifact.relativePath).toBe(`.e2e/cache/${expectedKey.keyHash}.json`);
    expect(cacheJson.payload.keyedBy.platform).toBe("android");
    expect(cacheJson.payload.keyedBy.engineName).toBe("mobile");
    expect(cacheJson.payload.startPath).toBe("com.softprobe.fixture.invite");
    expect(cacheJson.payload.endPath).toBe("com.softprobe.fixture.invite");
    expect(cacheJson.payload.truncated).toBeUndefined();
    expect(cacheJson.payload.goneAnchors).toBeUndefined();
    expect(
      cacheJson.payload.endAnchors?.find((a) => a.role === "textbox")?.value,
    ).toBe("ada@acme.com");
    expect(cacheJson.payload.actions.map((a) => a.name)).toEqual([
      "type",
      "typeSecret",
      "tap",
    ]);
    expect(cacheJson.payload.actions[1]?.secret).toBe("ADMIN_PASSWORD");
  });

  it("compiles otel_sdk iOS sessions to @softprobe/e2e/mobile with session correlation and device.openLink", () => {
    const envelope = createOtelSdkIosSessionEnvelope();
    const bundle = extractSessionBundleFromSpans(envelope);

    expect(bundle.platform).toBe("ios");
    expect(bundle.captureSource).toBe("otel_sdk");
    expect(bundle.appBundleId).toBe("com.softprobe.travel.ios");
    expect(bundle.secretSlots).toEqual(["OTP_CODE"]);

    const compiled = compileSessionToMobileE2E(bundle);
    expect(compiled.platform).toBe("ios");
    expect(compiled.bundleId).toBe("com.softprobe.travel.ios");

    const testContent = compiled.files[0]!.content;
    const configContent = compiled.files[1]!.content;

    expect(testContent).toContain(`async ({ app, agent, screen, trace, device }) => {`);
    expect(testContent).toContain(`await app.open();`);
    expect(testContent).toContain(`"otp_code": secrets.get("OTP_CODE")`);
    expect(testContent).toContain(
      `await expect(screen.getByText("Fare held for 24h")).toBeVisible();`,
    );
    expect(testContent).toContain(`await device.openLink("softprobe://booking/42");`);
    expect(testContent).toContain(
      `await expect(screen.getByText("Booking #42")).toBeVisible();`,
    );
    expect(testContent).toContain(`url: new RegExp("/v1/pnr/hold$")`);

    expect(configContent).toContain(`platform: "ios",`);
    expect(configContent).toContain(`mode: "session",`);
    expect(configContent).toContain(`bundleId: "com.softprobe.travel.ios",`);

    const firstCache = JSON.parse(compiled.cacheFiles[0]!.content) as {
      readonly payload: {
        readonly truncated?: boolean;
        readonly keyedBy: { readonly platform: string; readonly engineName: string };
      };
    };
    expect(firstCache.payload.keyedBy.platform).toBe("ios");
    expect(firstCache.payload.keyedBy.engineName).toBe("mobile");
    expect(firstCache.payload.truncated).toBe(true);
  });

  it("compiles both Android host_agent and iOS otel_sdk sessions to Maestro YAML flows", () => {
    const androidBundle = extractSessionBundleFromSpans(createHostAgentAndroidSessionEnvelope());
    const androidMaestro = compileSessionToMaestro(androidBundle);

    expect(androidMaestro.runner).toBe("maestro");
    expect(androidMaestro.platform).toBe("android");
    expect(androidMaestro.bundleId).toBe("com.softprobe.fixture.invite");
    expect(androidMaestro.files).toHaveLength(1);
    expect(androidMaestro.files[0]!.relativePath).toBe(".maestro/recorded-session.yaml");

    const androidYaml = androidMaestro.files[0]!.content;
    expect(androidYaml).toContain("appId: com.softprobe.fixture.invite\n---\n");
    expect(androidYaml).toContain(
      [
        "- launchApp:",
        "    clearState: true",
        "    arguments:",
        '      api_base_url: "http://127.0.0.1:18088"',
      ].join("\n"),
    );
    expect(androidYaml).toContain(
      ['- tapOn:', '    id: "com.softprobe.fixture.invite:id/email_input"'].join("\n"),
    );
    expect(androidYaml).toContain('- inputText: "ada@acme.com"');
    expect(androidYaml).toContain('- inputText: "${SP_SECRET_ADMIN_PASSWORD}"');
    expect(androidYaml).toContain(
      ['- tapOn:', '    id: "com.softprobe.fixture.invite:id/send_invite_button"'].join("\n"),
    );
    expect(androidYaml).toContain('- assertVisible: "Invitation queued for ada@acme.com"');

    const iosBundle = extractSessionBundleFromSpans(createOtelSdkIosSessionEnvelope());
    const iosMaestro = compileSessionToMaestro(iosBundle);
    const iosYaml = iosMaestro.files[0]!.content;

    expect(iosYaml).toContain("appId: com.softprobe.travel.ios\n---\n");
    expect(iosYaml).toContain("- launchApp:\n    clearState: true\n");
    expect(iosYaml).not.toContain("arguments:");
    expect(iosYaml).toContain(
      ["- swipe:", "    from:", '      id: "results_list"', "    direction: UP"].join("\n"),
    );
    expect(iosYaml).toContain('- inputText: "${SP_SECRET_OTP_CODE}"');
    expect(iosYaml).toContain("- hideKeyboard");
    expect(iosYaml).toContain(['- longPressOn:', '    id: "hold_fare_btn"'].join("\n"));
    expect(iosYaml).toContain('- assertVisible: "Fare held for 24h"');
    expect(iosYaml).not.toContain("2026-11-25T09:00:00Z");
    expect(iosYaml).toContain("- back");
    expect(iosYaml).toContain('- openLink: "softprobe://booking/42"');
    expect(iosYaml).toContain('- assertVisible: "Booking #42"');
    expect(iosYaml).toContain("- scroll");
  });

  it("drives runCompileSessionCli across --session-file and --session-id for e2e-mobile and maestro", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "sp-compile-mobile-cli-"));
    const sessionEnvelope = createHostAgentAndroidSessionEnvelope();

    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/v1/llm/sessions/sess_android_host_01") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            session_id: sessionEnvelope.session_id,
            resourceSpans: sessionEnvelope.resourceSpans,
          }),
        );
        return;
      }
      if (url.pathname === `/api/traces/${INVITE_TRACE_ID}`) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(sessionEnvelope.tracesByTraceId[INVITE_TRACE_ID]));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end("{}");
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected TCP address");
    }
    const endpoint = `http://127.0.0.1:${address.port}`;

    try {
      const outE2EMobile = path.join(tempDir, "out-e2e-mobile");
      const e2eMobileRes = await runCompileSessionCli([
        "--session-id",
        "sess_android_host_01",
        "--endpoint",
        endpoint,
        "--runner",
        "e2e-mobile",
        "--bundle-id",
        "com.softprobe.fixture.invite",
        "--out",
        outE2EMobile,
        "--json",
      ]);

      expect(e2eMobileRes.ok).toBe(true);
      expect(e2eMobileRes.runner).toBe("e2e-mobile");
      expect(e2eMobileRes.platform).toBe("android");
      expect(e2eMobileRes.bundleId).toBe("com.softprobe.fixture.invite");
      expect(e2eMobileRes.actionCount).toBe(3);
      expect(e2eMobileRes.outboundAssertionCount).toBe(1);
      expect(existsSync(path.join(outE2EMobile, "e2e.config.ts"))).toBe(true);
      expect(existsSync(path.join(outE2EMobile, "tests/recorded-session.e2e.ts"))).toBe(true);
      expect(e2eMobileRes.cacheFilesWritten).toHaveLength(1);

      const sessionJsonFile = path.join(tempDir, "ios-session.json");
      writeFileSync(
        sessionJsonFile,
        JSON.stringify(createOtelSdkIosSessionEnvelope()),
        "utf8",
      );

      const outMaestro = path.join(tempDir, "out-maestro");
      const maestroRes = await runCompileSessionCli([
        "--session-file",
        sessionJsonFile,
        "--runner",
        "maestro",
        "--platform",
        "ios",
        "--bundle-id",
        "com.softprobe.travel.override",
        "--out",
        outMaestro,
        "--json",
      ]);

      expect(maestroRes.ok).toBe(true);
      expect(maestroRes.runner).toBe("maestro");
      expect(maestroRes.platform).toBe("ios");
      expect(maestroRes.bundleId).toBe("com.softprobe.travel.override");
      const flowFile = path.join(outMaestro, ".maestro/recorded-session.yaml");
      expect(existsSync(flowFile)).toBe(true);
      expect(readFileSync(flowFile, "utf8")).toContain(
        "appId: com.softprobe.travel.override",
      );

      await expect(
        runCompileSessionCli([
          "--session-file",
          sessionJsonFile,
          "--runner",
          "maestro",
          "--out",
          outMaestro,
        ]),
      ).rejects.toThrow(/Refusing to overwrite/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
