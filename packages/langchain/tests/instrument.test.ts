import { CallbackManager } from "@langchain/core/callbacks/manager";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it } from "vitest";
import { SoftprobeClient } from "@softprobe/tracing";
import {
  autoInstrumentFromEnv,
  instrument,
  isInstrumented,
  uninstrument,
} from "../src/instrument.js";

function makeClient() {
  const exporter = new InMemorySpanExporter();
  const client = new SoftprobeClient({
    publicKey: "test-key",
    baseUrl: "http://127.0.0.1:8091",
    otlpEndpoint: "http://127.0.0.1:8091/v1/traces",
    spanExporter: exporter,
    scoreTransport: { async createScore() {} },
    useSimpleProcessor: true,
    registerProvider: false,
    disableGlobalTracerOnShutdown: false,
  });
  return { client, exporter };
}

describe("instrument()", () => {
  afterEach(() => {
    uninstrument();
  });

  it("injects Softprobe into CallbackManager.configure", async () => {
    const { client } = makeClient();
    const handler = instrument({ softprobeClient: client });
    expect(isInstrumented()).toBe(true);
    const manager = await CallbackManager.configure([]);
    expect(manager?.handlers.some((h) => h.name === "SoftprobeCallbackHandler")).toBe(
      true,
    );
    expect(handler.name).toBe("SoftprobeCallbackHandler");
    await client.shutdown();
  });

  it("autoInstrumentFromEnv no-ops without credentials", () => {
    uninstrument();
    expect(
      autoInstrumentFromEnv({}, { SOFTPROBE_PUBLIC_KEY: "only" }),
    ).toBeNull();
  });

  it("autoInstrumentFromEnv respects SOFTPROBE_LANGCHAIN=0", () => {
    uninstrument();
    expect(
      autoInstrumentFromEnv(
        {},
        {
          SOFTPROBE_PUBLIC_KEY: "pk",
          SOFTPROBE_BASE_URL: "http://127.0.0.1:8091",
          SOFTPROBE_LANGCHAIN: "0",
        },
      ),
    ).toBeNull();
  });
});
