import { afterEach, describe, expect, it, vi } from "vitest";

const { init } = vi.hoisted(() => ({
  init: vi.fn(() => ({ stop: vi.fn() })),
}));

vi.mock("@softprobe/web-record", () => ({
  RecordSdk: { init },
}));

import { boot, readOrCreateSessionId, readScriptConfig } from "../src/boot.js";

function script(attrs: Record<string, string>): HTMLScriptElement {
  const el = document.createElement("script");
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

describe("readScriptConfig", () => {
  it("reads Agent and capture settings from one script tag", () => {
    expect(
      readScriptConfig(
        script({
          "data-api-key": " spk_agent ",
          "data-base-url": " https://explorer.example/api/thelake ",
          "data-api-origins": "https://app.example, https://api.example,https://app.example",
          "data-environment": "staging",
          "data-service-name": "travel-ota-web",
          "data-mask-all-inputs": "true",
          "data-mask-text-selector": ".private, .secret",
          "data-block-selector": "#payment-details",
        }),
      ),
    ).toEqual({
      apiKey: "spk_agent",
      baseUrl: "https://explorer.example/api/thelake",
      apiOrigins: ["https://app.example", "https://api.example"],
      environment: "staging",
      serviceName: "travel-ota-web",
      maskAllInputs: true,
      maskTextSelector: ".private, .secret",
      blockSelector: "#payment-details",
    });
  });

  it("keeps the legacy public key tag working without capture identity", () => {
    expect(readScriptConfig(script({
      "data-base-url": "http://lake",
      "data-public-key": "legacy-public-key",
    }))).toMatchObject({ apiKey: "legacy-public-key" });
    expect(readScriptConfig(script({
      "data-base-url": "http://lake",
      "data-public-key": "legacy-public-key",
    }))).not.toHaveProperty("captureId");
  });

  it("returns null when required setup attributes are missing", () => {
    expect(readScriptConfig(script({ "data-base-url": "http://lake" }))).toBeNull();
    expect(readScriptConfig(null)).toBeNull();
  });
});

describe("readOrCreateSessionId", () => {
  it("keeps the id already stored for this tab", () => {
    const storage = new Map<string, string>();
    const fake = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
    } as Storage;
    fake.setItem("x-sp-session-id", "sp-session-existing");
    expect(readOrCreateSessionId(fake)).toBe("sp-session-existing");
    expect(readOrCreateSessionId(fake)).toBe("sp-session-existing");
  });

  it("creates an id when crypto.randomUUID is unavailable", () => {
    const storage = new Map<string, string>();
    const fake = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
    } as Storage;
    const randomUUID = crypto.randomUUID;
    Object.defineProperty(crypto, "randomUUID", {
      value: undefined,
      configurable: true,
    });
    try {
      const id = readOrCreateSessionId(fake);
      expect(id).toMatch(
        /^sp-session-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(storage.get("x-sp-session-id")).toBe(id);
    } finally {
      Object.defineProperty(crypto, "randomUUID", {
        value: randomUUID,
        configurable: true,
      });
    }
  });
});

describe("boot", () => {
  afterEach(() => {
    init.mockClear();
    delete (window as Window & { __softprobeSession?: unknown }).__softprobeSession;
    sessionStorage.clear();
  });

  it("initializes the capture SDK once from the script tag", () => {
    const tag = script({
      "data-base-url": "http://10.0.0.170:30091",
      "data-api-key": "agent-key",
      "data-api-origins": "https://api.example",
      "data-mask-text-selector": ".private",
    });
    const first = boot(tag);
    const second = boot(tag);
    expect(first).toBe(second);
    expect(init).toHaveBeenCalledTimes(1);
    const arg = init.mock.calls[0]?.[0] as {
      apiKey: string;
      baseUrl: string;
      apiOrigins: string[];
      maskTextSelector: string;
      sessionId: string;
    };
    expect(arg.apiKey).toBe("agent-key");
    expect(arg.baseUrl).toBe("http://10.0.0.170:30091");
    expect(arg.apiOrigins).toEqual(["https://api.example"]);
    expect(arg.maskTextSelector).toBe(".private");
    expect(arg.sessionId).toMatch(/^sp-session-/);
    expect(sessionStorage.getItem("x-sp-session-id")).toBe(arg.sessionId);
  });

  it("does not call init when the script tag has no credentials", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(boot(script({}))).toBeNull();
    expect(init).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
