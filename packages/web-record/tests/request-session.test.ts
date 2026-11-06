import { afterEach, expect, it, vi } from "vitest";
import { RecordSdk } from "../src/sdk.js";

afterEach(() => {
  sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("exports each request under the session active when it started", async () => {
  let releaseFirst!: (response: Response) => void;
  const firstResponse = new Promise<Response>((resolve) => { releaseFirst = resolve; });
  const traceIds = new Map<string, string>();
  const exports: Array<{ traceId: string; attributes: Array<{ key: string; value: { stringValue?: string } }> }> = [];
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://collector.example.test/v1/traces") {
      const envelope = JSON.parse(String(init?.body));
      exports.push(envelope.resourceSpans[0].scopeSpans[0].spans[0]);
      return Promise.resolve(new Response("{}", { status: 200 }));
    }
    traceIds.set(url, new Headers(init?.headers).get("traceparent")!.split("-")[1]!);
    return url.endsWith("/first") ? firstResponse : Promise.resolve(new Response("second", { status: 200 }));
  }));

  const sdk = RecordSdk.init({
    apiKey: "agent-key",
    baseUrl: "https://collector.example.test",
    sessionId: "session-a",
    apiOrigins: ["https://api.example.test"],
    manual: true,
  });

  const first = fetch("https://api.example.test/first");
  try {
    await sdk.setSessionId("session-b");
    await fetch("https://api.example.test/second");
    releaseFirst(new Response("first", { status: 200 }));
    await first;
    expect(await sdk.flush()).toBe(true);

    expect(exports).toHaveLength(2);
    const sessionFor = (url: string) => exports
      .find((span) => span.traceId === traceIds.get(url))
      ?.attributes.find((attribute) => attribute.key === "sp.session.id")?.value.stringValue;
    expect(sessionFor("https://api.example.test/first")).toBe("session-a");
    expect(sessionFor("https://api.example.test/second")).toBe("session-b");
    expect(traceIds.get("https://api.example.test/first")).not.toBe(traceIds.get("https://api.example.test/second"));
  } finally {
    releaseFirst(new Response("first", { status: 200 }));
  }
});
