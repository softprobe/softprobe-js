import { describe, expect, it } from "vitest";
import {
  deriveOtlpEndpoint,
  MissingSoftprobeCredentialsError,
  resolveSoftprobeConfigFromEnv,
  resolveSoftprobeConfigFromObject,
} from "../src/config.js";

describe("deriveOtlpEndpoint", () => {
  it("defaults to baseUrl/v1/traces", () => {
    expect(deriveOtlpEndpoint("http://127.0.0.1:8091")).toBe(
      "http://127.0.0.1:8091/v1/traces",
    );
    expect(deriveOtlpEndpoint("http://127.0.0.1:8091/")).toBe(
      "http://127.0.0.1:8091/v1/traces",
    );
  });

  it("honors explicit endpoint", () => {
    expect(
      deriveOtlpEndpoint("http://127.0.0.1:8091", "http://custom/traces"),
    ).toBe("http://custom/traces");
  });
});

describe("resolveSoftprobeConfigFromEnv", () => {
  it("returns null when required keys are missing", () => {
    expect(resolveSoftprobeConfigFromEnv({})).toBeNull();
    expect(
      resolveSoftprobeConfigFromEnv({ SOFTPROBE_PUBLIC_KEY: "pk" }),
    ).toBeNull();
  });

  it("parses full env config", () => {
    expect(
      resolveSoftprobeConfigFromEnv({
        SOFTPROBE_PUBLIC_KEY: " pk ",
        SOFTPROBE_BASE_URL: "http://127.0.0.1:8091",
        SOFTPROBE_ENVIRONMENT: "staging",
        SOFTPROBE_USER_ID: "dev",
      }),
    ).toEqual({
      publicKey: "pk",
      baseUrl: "http://127.0.0.1:8091",
      otlpEndpoint: "http://127.0.0.1:8091/v1/traces",
      environment: "staging",
      userId: "dev",
      serviceName: undefined,
    });
  });
});

describe("resolveSoftprobeConfigFromObject", () => {
  it("validates required fields", () => {
    expect(() => resolveSoftprobeConfigFromObject(null)).toThrow(
      MissingSoftprobeCredentialsError,
    );
    expect(() => resolveSoftprobeConfigFromObject({ publicKey: "pk" })).toThrow(
      /publicKey and baseUrl/,
    );
  });

  it("derives otlp endpoint from baseUrl", () => {
    expect(
      resolveSoftprobeConfigFromObject({
        publicKey: "pk",
        baseUrl: "https://softprobe.example",
      }),
    ).toEqual({
      publicKey: "pk",
      baseUrl: "https://softprobe.example",
      otlpEndpoint: "https://softprobe.example/v1/traces",
      environment: undefined,
      userId: undefined,
      serviceName: undefined,
    });
  });
});
