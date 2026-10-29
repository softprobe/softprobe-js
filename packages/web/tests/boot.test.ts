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
  it("reads data-base-url and data-public-key", () => {
    expect(
      readScriptConfig(
        script({
          "data-base-url": "http://10.0.0.170:30091",
          "data-public-key": "home-demo",
        }),
      ),
    ).toEqual({
      baseUrl: "http://10.0.0.170:30091",
      publicKey: "home-demo",
    });
  });

  it("returns null when an attribute is missing", () => {
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
});

describe("boot", () => {
  afterEach(() => {
    init.mockClear();
    delete (window as Window & { __softprobeSession?: unknown }).__softprobeSession;
    sessionStorage.clear();
  });

  it("calls RecordSdk.init once with the script attributes and a stored session id", () => {
    const tag = script({
      "data-base-url": "http://10.0.0.170:30091",
      "data-public-key": "home-demo",
    });
    const first = boot(tag);
    const second = boot(tag);
    expect(first).toBe(second);
    expect(init).toHaveBeenCalledTimes(1);
    const arg = init.mock.calls[0]?.[0] as {
      publicKey: string;
      baseUrl: string;
      sessionId: string;
    };
    expect(arg.publicKey).toBe("home-demo");
    expect(arg.baseUrl).toBe("http://10.0.0.170:30091");
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
