import { afterEach, describe, expect, it, vi } from "vitest";
import { context, propagation, trace } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace";
import { record as rrwebRecord } from "rrweb";
import { createBrowserRuntime, type BrowserRuntime } from "../src/browser-runtime.js";
import { createSemanticActionRecorder, type SemanticActionRecorder } from "../src/semantic-actions.js";
import { createWebSessionState } from "../src/session-state.js";
import { RecordSdk } from "../src/sdk.js";
import type { RecordedSemanticAction } from "../src/types.js";

let runtime: BrowserRuntime | null = null;
let recorder: SemanticActionRecorder | null = null;
let sdkInstance: ReturnType<typeof RecordSdk.init> | null = null;

afterEach(async () => {
  recorder?.stop();
  recorder = null;
  sdkInstance?.stop();
  sdkInstance = null;
  await runtime?.shutdown();
  runtime = null;
  trace.disable();
  context.disable();
  propagation.disable();
  document.body.innerHTML = "";
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function parseSemanticActions(exporter: InMemorySpanExporter): RecordedSemanticAction[] {
  return exporter
    .getFinishedSpans()
    .filter((span) => span.name === "softprobe.ui.action")
    .map((span) => {
      expect(span.attributes["sp.observation.type"]).toBe("ui_action");
      expect(span.attributes["sp.ui.action.schema"]).toBe("sp-ui-action-1");
      expect(typeof span.attributes["sp.ui.action.summary"]).toBe("string");
      const raw = String(span.attributes["sp.ui.action.payload"]);
      return JSON.parse(raw) as RecordedSemanticAction;
    });
}

describe("Semantic action recorder (sp-ui-action-1)", () => {
  it("keeps semantic action capture disabled by default for backwards compatibility", async () => {
    const exporter = new InMemorySpanExporter();
    const browserRuntime = createBrowserRuntime(
      {
        ingestionKey: "agent-key",
        otlpEndpoint: "https://collector.example.test/v1/traces",
        serviceName: "compat-app",
      },
      createWebSessionState("sess-compat"),
      exporter,
    );
    runtime = browserRuntime;

    document.body.innerHTML = `<button id="btn" type="button">Save</button>`;
    document.getElementById("btn")!.click();
    await browserRuntime.forceFlush();

    expect(
      exporter.getFinishedSpans().filter((s) => s.name === "softprobe.ui.action"),
    ).toHaveLength(0);
  });

  it("coalesces keystrokes into fill, classifies secrets-only password slots vs literal inputs, and flushes fill before Enter press", async () => {
    const exporter = new InMemorySpanExporter();
    const browserRuntime = createBrowserRuntime(
      {
        ingestionKey: "agent-key",
        otlpEndpoint: "https://collector.example.test/v1/traces",
        serviceName: "auth-app",
        onHttpSpanStart: (info) => recorder?.onHttpSpanStart(info),
        onHttpSpan: (info) => recorder?.onHttpSpan(info),
      },
      createWebSessionState("sess-auth"),
      exporter,
    );
    runtime = browserRuntime;
    recorder = createSemanticActionRecorder({
      getTracer: () => browserRuntime.tracer,
      isRrwebActive: () => false,
      inputCapture: "secrets-only",
      secretSlots: { 'input[name="apiKey"]': "API_KEY" },
    });

    document.body.innerHTML = `
      <form id="login-form">
        <label for="email">Email address</label>
        <input id="email" name="email" type="email" placeholder="you@example.com" />
        <label for="pwd">Password</label>
        <input id="pwd" name="pwd" type="password" />
        <label for="api-key">Integration key</label>
        <input id="api-key" name="apiKey" type="text" />
        <div role="status" id="login-status">Signed out</div>
      </form>
    `;

    const emailEl = document.getElementById("email") as HTMLInputElement;
    const pwdEl = document.getElementById("pwd") as HTMLInputElement;
    const apiKeyEl = document.getElementById("api-key") as HTMLInputElement;

    emailEl.focus();
    for (const partial of ["a", "al", "alice@softprobe.ai"]) {
      emailEl.value = partial;
      emailEl.dispatchEvent(new Event("input", { bubbles: true }));
    }

    pwdEl.focus();
    pwdEl.value = "hunter2-super-secret";
    pwdEl.dispatchEvent(new Event("input", { bubbles: true }));

    apiKeyEl.focus();
    apiKeyEl.value = "sk_live_secret_value_999";
    apiKeyEl.dispatchEvent(new Event("input", { bubbles: true }));

    apiKeyEl.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    document.getElementById("login-status")!.textContent = "Signed in as alice@softprobe.ai";

    recorder.flush();
    await browserRuntime.forceFlush();

    const actions = parseSemanticActions(exporter);
    expect(actions.map((a) => a.verb.name)).toEqual(["fill", "fill", "fill", "press"]);
    expect(actions.map((a) => a.actionIndex)).toEqual([0, 1, 2, 3]);

    expect(actions[0]?.verb).toMatchObject({
      name: "fill",
      target: { role: "textbox", name: "Email address", placeholder: "you@example.com" },
      value: { kind: "literal", value: "alice@softprobe.ai" },
    });
    expect(actions[1]?.verb).toMatchObject({
      name: "fill",
      target: { role: "textbox", name: "Password", inputPurpose: "password" },
      value: { kind: "secret", slot: "PASSWORD" },
    });
    expect(actions[2]?.verb).toMatchObject({
      name: "fill",
      target: { role: "textbox", name: "Integration key" },
      value: { kind: "secret", slot: "API_KEY" },
    });
    expect(actions[3]?.verb).toMatchObject({
      name: "press",
      key: "Enter",
      target: { role: "textbox", name: "Integration key" },
    });
    expect(actions[3]?.endAnchors).toContainEqual(
      expect.objectContaining({
        role: "status",
        name: "Signed in as alice@softprobe.ai",
      }),
    );
    expect(actions[3]?.goneAnchors).toContainEqual(
      expect.objectContaining({
        role: "status",
        name: "Signed out",
      }),
    );

    const serializedSpans = JSON.stringify(exporter.getFinishedSpans().map((s) => s.attributes));
    expect(serializedSpans).not.toContain("hunter2-super-secret");
    expect(serializedSpans).not.toContain("sk_live_secret_value_999");
  });

  it("captures click, dblclick, press Escape/ArrowDown, select, check without duplicate click, upload, dialog confirm, and pushState navigation", async () => {
    const exporter = new InMemorySpanExporter();
    const browserRuntime = createBrowserRuntime(
      {
        ingestionKey: "agent-key",
        otlpEndpoint: "https://collector.example.test/v1/traces",
        serviceName: "controls-app",
      },
      createWebSessionState("sess-controls"),
      exporter,
    );
    runtime = browserRuntime;

    vi.stubGlobal("confirm", vi.fn(() => true));

    recorder = createSemanticActionRecorder({
      getTracer: () => browserRuntime.tracer,
      isRrwebActive: () => false,
      inputCapture: "secrets-only",
    });

    document.body.innerHTML = `
      <div>
        <button id="open-menu" data-testid="menu-trigger" type="button">Actions</button>
        <div id="card-item" role="button">Invoice #104</div>
        <label for="role-select">Member role</label>
        <select id="role-select">
          <option value="viewer">Viewer</option>
          <option value="admin">Administrator</option>
        </select>
        <label><input id="agree-box" type="checkbox" /> Accept terms</label>
        <label for="avatar-file">Avatar image</label>
        <input id="avatar-file" type="file" />
        <button id="delete-btn" type="button">Delete workspace</button>
      </div>
    `;

    const menuBtn = document.getElementById("open-menu")!;
    menuBtn.click();
    menuBtn.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    menuBtn.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    document.getElementById("card-item")!.dispatchEvent(
      new MouseEvent("dblclick", { bubbles: true, clientX: 40, clientY: 50 }),
    );

    const roleSelect = document.getElementById("role-select") as HTMLSelectElement;
    roleSelect.value = "admin";
    roleSelect.dispatchEvent(new Event("change", { bubbles: true }));

    const checkbox = document.getElementById("agree-box") as HTMLInputElement;
    checkbox.click();
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));

    const fileInput = document.getElementById("avatar-file") as HTMLInputElement;
    const mockFile = new File(["pngdata"], "profile.png", { type: "image/png" });
    Object.defineProperty(fileInput, "files", {
      value: [mockFile],
      configurable: true,
    });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));

    document.getElementById("delete-btn")!.addEventListener("click", () => {
      if (window.confirm("Are you sure?")) {
        window.history.pushState({}, "", "/goodbye");
      }
    });
    document.getElementById("delete-btn")!.click();

    window.history.pushState({}, "", "/settings?tab=billing");

    recorder.flush();
    await browserRuntime.forceFlush();

    const actions = parseSemanticActions(exporter);
    expect(actions.map((a) => a.verb.name)).toEqual([
      "click",
      "press",
      "press",
      "dblclick",
      "select",
      "check",
      "upload",
      "click",
      "dialog",
      "navigate",
    ]);

    expect(actions[0]?.verb).toMatchObject({
      name: "click",
      target: { testId: "menu-trigger", role: "button", name: "Actions" },
    });
    expect(actions[1]?.verb).toMatchObject({ name: "press", key: "ArrowDown" });
    expect(actions[2]?.verb).toMatchObject({ name: "press", key: "Escape" });
    expect(actions[3]?.verb).toMatchObject({
      name: "dblclick",
      target: { role: "button", name: "Invoice #104" },
    });
    expect(actions[4]?.verb).toMatchObject({
      name: "select",
      target: { role: "combobox", name: "Member role" },
      value: { kind: "literal", value: "admin" },
      optionLabel: "Administrator",
    });
    expect(actions[5]?.verb).toMatchObject({
      name: "check",
      target: { role: "checkbox", name: "Accept terms" },
      checked: true,
    });
    expect(actions[6]?.verb).toMatchObject({
      name: "upload",
      target: { role: "button", name: "Avatar image" },
      fileNames: ["profile.png"],
      mimeTypes: ["image/png"],
    });
    expect(actions[8]?.verb).toMatchObject({
      name: "dialog",
      dialogType: "confirm",
      accepted: true,
    });
    expect(actions[9]?.verb).toMatchObject({
      name: "navigate",
      url: "/settings?tab=billing",
      trigger: "pushState",
    });
  });

  it("disambiguates twin controls via container within and position, links rrweb mirror node IDs, and attaches causedTraces", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ revoked: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const getIdSpy = vi.fn((node: Node) => (node instanceof Element && node.id === "revoke-bob" ? 42 : 7));
    const addCustomEventSpy = vi.fn();
    Object.defineProperty(rrwebRecord, "mirror", {
      value: { getId: getIdSpy },
      configurable: true,
    });
    Object.defineProperty(rrwebRecord, "addCustomEvent", {
      value: addCustomEventSpy,
      configurable: true,
    });

    const exporter = new InMemorySpanExporter();
    const browserRuntime = createBrowserRuntime(
      {
        ingestionKey: "agent-key",
        otlpEndpoint: "https://collector.example.test/v1/traces",
        serviceName: "members-app",
        apiOrigins: [window.location.origin],
        onHttpSpanStart: (info) => recorder?.onHttpSpanStart(info),
        onHttpSpan: (info) => recorder?.onHttpSpan(info),
      },
      createWebSessionState("sess-members"),
      exporter,
    );
    runtime = browserRuntime;

    recorder = createSemanticActionRecorder({
      getTracer: () => browserRuntime.tracer,
      isRrwebActive: () => true,
      inputCapture: "secrets-only",
    });

    document.body.innerHTML = `
      <table>
        <tbody>
          <tr>
            <td>alice@softprobe.ai</td>
            <td><button id="revoke-alice" type="button">Revoke</button></td>
          </tr>
          <tr>
            <td>bob@softprobe.ai</td>
            <td>
              <button id="revoke-bob" type="button">Revoke</button>
              <button id="revoke-bob-2" type="button">Revoke</button>
            </td>
          </tr>
        </tbody>
      </table>
      <div role="status" id="banner">Idle</div>
    `;

    const revokeBobBtn = document.getElementById("revoke-bob")!;
    revokeBobBtn.addEventListener("click", async () => {
      await fetch(`${window.location.origin}/api/invites/bob`, {
        method: "DELETE",
      });
      document.getElementById("banner")!.textContent = "Revoked bob@softprobe.ai";
    });

    revokeBobBtn.click();
    await new Promise((r) => setTimeout(r, 80));
    await browserRuntime.waitForIdle();
    recorder.flush();
    await browserRuntime.forceFlush();

    const spans = exporter.getFinishedSpans();
    const httpClientSpan = spans.find((s) => s.kind === 2);
    expect(httpClientSpan).toBeDefined();

    const uiActionSpan = spans.find((s) => s.name === "softprobe.ui.action");
    expect(uiActionSpan).toBeDefined();
    expect(uiActionSpan?.attributes["sp.ui.action.rrweb_node_id"]).toBe(42);

    const actions = parseSemanticActions(exporter);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.verb).toMatchObject({
      name: "click",
      target: {
        role: "button",
        name: "Revoke",
        within: "bob@softprobe.ai",
        position: { index: 0, of: 2 },
        rrwebNodeId: 42,
      },
    });
    expect(actions[0]?.causedTraces).toEqual([
      expect.objectContaining({
        traceId: httpClientSpan!.spanContext().traceId,
        spanId: httpClientSpan!.spanContext().spanId,
        method: "DELETE",
        url: `${window.location.origin}/api/invites/bob`,
        status: 200,
      }),
    ]);
    expect(actions[0]?.endAnchors).toContainEqual(
      expect.objectContaining({
        role: "status",
        name: "Revoked bob@softprobe.ai",
      }),
    );
    expect(addCustomEventSpy).toHaveBeenCalledWith(
      "sp.ui.action",
      expect.objectContaining({
        actionIndex: 0,
        verb: "click",
        rrwebNodeId: 42,
      }),
    );
  });

  it("flushes pending semantic actions end-to-end via RecordSdk.init({ captureSemanticActions: true })", async () => {
    const otlpRequests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        otlpRequests.push(String(input));
        return new Response("{}", { status: 200 });
      }),
    );

    document.body.innerHTML = `
      <label for="sdk-search">Search query</label>
      <input id="sdk-search" type="text" />
      <button id="sdk-go" type="button">Run search</button>
    `;

    sdkInstance = RecordSdk.init({
      ingestionKey: "sp_sdk_key",
      otlp: { tracesEndpoint: "https://collector.example.test/v1/traces" },
      sessionId: "sess-sdk-e2e",
      captureSemanticActions: true,
    });

    const input = document.getElementById("sdk-search") as HTMLInputElement;
    input.focus();
    input.value = "distributed traces";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("sdk-go")!.click();

    const flushed = await sdkInstance.flush();
    expect(flushed).toBe(true);
    expect(otlpRequests.some((u) => u.includes("/v1/traces"))).toBe(true);
  });
});
