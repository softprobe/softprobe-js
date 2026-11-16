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
    expect(resolveSoftprobeConfigFromEnv({ SOFTPROBE_PUBLIC_KEY: "pk" }))
      .toMatchObject({
        baseUrl: "https://explorer.softprobe.ai/api/thelake",
        otlpEndpoint: "https://explorer.softprobe.ai/api/thelake/v1/traces",
      });
  });

  it("uses standard OTLP settings without a Softprobe API base", () => {
    expect(resolveSoftprobeConfigFromEnv({
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT:
        "https://explorer-staging.softprobe.ai/api/thelake/v1/traces",
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: "Authorization=Bearer staging-key",
      OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/protobuf",
      OTEL_RESOURCE_ATTRIBUTES: "deployment.environment.name=staging",
    })).toMatchObject({
      ingestionKey: "staging-key",
      baseUrl: "https://explorer.softprobe.ai/api/thelake",
      otlpEndpoint: "https://explorer-staging.softprobe.ai/api/thelake/v1/traces",
      resourceAttributes: { "deployment.environment.name": "staging" },
    });
  });

  it("resolves INGESTION_KEY directly when no OTLP authorization header is set", () => {
    expect(resolveSoftprobeConfigFromEnv({
      INGESTION_KEY: "staging-key",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT:
        "https://explorer-staging.softprobe.ai/api/thelake/v1/traces",
    })).toMatchObject({
      ingestionKey: "staging-key",
      otlpEndpoint: "https://explorer-staging.softprobe.ai/api/thelake/v1/traces",
    });
  });

  it("parses full env config", () => {
    expect(
      resolveSoftprobeConfigFromEnv({
        SOFTPROBE_PUBLIC_KEY: " pk ",
        SOFTPROBE_BASE_URL: "http://127.0.0.1:8091",
        SOFTPROBE_ENVIRONMENT: "staging",
        SOFTPROBE_USER_ID: "dev",
      }),
    ).toMatchObject({
      ingestionKey: "pk",
      publicKey: "pk",
      baseUrl: "http://127.0.0.1:8091",
      otlpEndpoint: "http://127.0.0.1:8091/v1/traces",
      otlp: {
        tracesEndpoint: "http://127.0.0.1:8091/v1/traces",
        protocol: "http/protobuf",
      },
      environment: "staging",
      sessionId: undefined,
      userId: "dev",
      serviceName: undefined,
    });
  });

  it("uses standard OTLP trace-specific settings and resource attributes", () => {
    const cfg = resolveSoftprobeConfigFromEnv({
      SOFTPROBE_BASE_URL: "https://explorer-staging.softprobe.ai/api/thelake",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example/base",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT:
        "https://explorer-staging.softprobe.ai/api/thelake/v1/traces",
      OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer common,x-common=yes",
      OTEL_EXPORTER_OTLP_TRACES_HEADERS:
        "authorization=Bearer staging,x-traces=yes",
      OTEL_EXPORTER_OTLP_PROTOCOL: "grpc",
      OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/protobuf",
      OTEL_RESOURCE_ATTRIBUTES:
        "deployment.environment.name=staging,service.name=from-attributes",
      OTEL_SERVICE_NAME: "staging-agent",
    });

    expect(cfg).toMatchObject({
      ingestionKey: "staging",
      publicKey: "staging",
      baseUrl: "https://explorer-staging.softprobe.ai/api/thelake",
      otlpEndpoint: "https://explorer-staging.softprobe.ai/api/thelake/v1/traces",
      otlp: {
        tracesEndpoint: "https://explorer-staging.softprobe.ai/api/thelake/v1/traces",
        protocol: "http/protobuf",
        headers: {
          authorization: "Bearer staging",
          "x-common": "yes",
          "x-traces": "yes",
        },
      },
      resourceAttributes: {
        "deployment.environment.name": "staging",
        "service.name": "staging-agent",
      },
      serviceName: "staging-agent",
      environment: "staging",
    });
  });

  it("uses the generic endpoint as a base and the generic headers as defaults", () => {
    const cfg = resolveSoftprobeConfigFromEnv({
      SOFTPROBE_BASE_URL: "https://explorer-staging.softprobe.ai/api/thelake",
      OTEL_EXPORTER_OTLP_HEADERS:
        "Authorization=Bearer staging,x-common=yes",
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
      OTEL_EXPORTER_OTLP_ENDPOINT:
        "https://explorer-staging.softprobe.ai/api/thelake",
    });

    expect(cfg?.otlpEndpoint).toBe(
      "https://explorer-staging.softprobe.ai/api/thelake/v1/traces",
    );
    expect(cfg?.otlp).toMatchObject({
      endpoint: "https://explorer-staging.softprobe.ai/api/thelake",
      protocol: "http/protobuf",
      headers: {
        Authorization: "Bearer staging",
        "x-common": "yes",
      },
    });
  });
});

describe("resolveSoftprobeConfigFromObject", () => {
  it("validates required fields", () => {
    expect(() => resolveSoftprobeConfigFromObject(null)).toThrow(
      MissingSoftprobeCredentialsError,
    );
    expect(() => resolveSoftprobeConfigFromObject({})).toThrow(/ingestionKey/);
  });

  it("derives otlp endpoint from baseUrl", () => {
    expect(
      resolveSoftprobeConfigFromObject({
        ingestionKey: "pk",
        baseUrl: "https://softprobe.example",
      }),
    ).toMatchObject({
      ingestionKey: "pk",
      publicKey: "pk",
      baseUrl: "https://softprobe.example",
      otlpEndpoint: "https://softprobe.example/v1/traces",
    });
  });

  it("defaults direct configuration to the production traces endpoint", () => {
    expect(resolveSoftprobeConfigFromObject({ ingestionKey: "pk" })).toMatchObject({
      baseUrl: "https://explorer.softprobe.ai/api/thelake",
      otlpEndpoint: "https://explorer.softprobe.ai/api/thelake/v1/traces",
    });
  });

  it("accepts equivalent direct OTLP and resource options", () => {
    expect(
      resolveSoftprobeConfigFromObject({
        ingestionKey: "pk",
        baseUrl: "https://scores.example.test/api",
        otlp: {
          endpoint: "https://collector.example/base",
          tracesEndpoint:
            "https://explorer-staging.softprobe.ai/api/thelake/v1/traces",
          protocol: "http/protobuf",
          headers: { "x-sdk": "direct" },
        },
        resourceAttributes: { "deployment.environment.name": "staging" },
      }),
    ).toMatchObject({
      ingestionKey: "pk",
      baseUrl: "https://scores.example.test/api",
      otlpEndpoint: "https://explorer-staging.softprobe.ai/api/thelake/v1/traces",
      otlp: {
        endpoint: "https://collector.example/base",
        tracesEndpoint:
          "https://explorer-staging.softprobe.ai/api/thelake/v1/traces",
        protocol: "http/protobuf",
        headers: { "x-sdk": "direct" },
      },
      resourceAttributes: { "deployment.environment.name": "staging" },
    });
  });

  it("accepts a trace endpoint without a separate API base", () => {
    expect(resolveSoftprobeConfigFromObject({
      ingestionKey: "staging-key",
      otlp: {
        tracesEndpoint:
          "https://explorer-staging.softprobe.ai/api/thelake/v1/traces",
        protocol: "http/protobuf",
      },
    })).toMatchObject({
      baseUrl: "https://explorer.softprobe.ai/api/thelake",
      otlpEndpoint: "https://explorer-staging.softprobe.ai/api/thelake/v1/traces",
    });
  });

  it("rejects an explicitly blank API base", () => {
    expect(() => resolveSoftprobeConfigFromObject({
      ingestionKey: "pk",
      baseUrl: "",
    })).toThrow(/baseUrl must be non-empty/);
  });

  it("rejects protocols the Softprobe exporter cannot use", () => {
    expect(() =>
      resolveSoftprobeConfigFromObject({
        ingestionKey: "pk",
        baseUrl: "https://collector.example",
        otlp: { protocol: "grpc" },
      }),
    ).toThrow(/http\/protobuf/);
  });
});
