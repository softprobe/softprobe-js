import { ExportResultCode } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it, vi } from "vitest";
import { RetryingSpanExporter } from "../src/retrying-exporter.js";

describe("RetryingSpanExporter", () => {
  it("retries failed exports then succeeds", async () => {
    const calls: number[] = [];
    const inner: SpanExporter = {
      export(_spans, resultCallback) {
        calls.push(1);
        if (calls.length < 3) {
          resultCallback({ code: ExportResultCode.FAILED });
          return;
        }
        resultCallback({ code: ExportResultCode.SUCCESS });
      },
      shutdown: async () => undefined,
    };
    const exporter = new RetryingSpanExporter(inner, {
      maxAttempts: 4,
      baseDelayMs: 1,
      maxDelayMs: 5,
    });

    const result = await new Promise((resolve) => {
      exporter.export([] as ReadableSpan[], resolve);
    });

    expect(result).toEqual({ code: ExportResultCode.SUCCESS });
    expect(calls.length).toBe(3);
  });

  it("stops after maxAttempts", async () => {
    const inner: SpanExporter = {
      export(_spans, resultCallback) {
        resultCallback({ code: ExportResultCode.FAILED });
      },
      shutdown: async () => undefined,
    };
    const exporter = new RetryingSpanExporter(inner, {
      maxAttempts: 2,
      baseDelayMs: 1,
      maxDelayMs: 5,
    });
    const exportSpy = vi.spyOn(inner, "export");

    const result = await new Promise((resolve) => {
      exporter.export([] as ReadableSpan[], resolve);
    });

    expect(result).toEqual({ code: ExportResultCode.FAILED });
    expect(exportSpy).toHaveBeenCalledTimes(2);
  });
});
