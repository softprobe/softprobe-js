import {
  context,
  diag,
  DiagConsoleLogger,
  DiagLogLevel,
  ROOT_CONTEXT,
  trace,
} from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { Resource } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
  type BufferConfig,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import {
  Generation,
  Observation,
  startGenerationSpan,
  startObservationSpan,
  withObservationContext,
  type ObservationRuntime,
} from "./observation.js";
import { withAttributes as withAttributesFn } from "./propagation.js";
import {
  deriveOtlpEndpoint,
  MissingSoftprobeCredentialsError,
  resolveSoftprobeConfigFromEnv,
} from "./config.js";
import { defaultRedactKeys } from "./redaction.js";
import { buildScoreRequest, HttpScoreTransport } from "./scores.js";
import { RetryingSpanExporter } from "./retrying-exporter.js";
import { toolSpanAttributes } from "./tools.js";
import type {
  CreateScoreOptions,
  ObservationType,
  ScoreTransport,
  SoftprobeConfig,
  StartGenerationOptions,
  StartObservationOptions,
  StartToolOptions,
} from "./types.js";

const DEFAULT_THELAKE_BASE_URL = "https://explorer.softprobe.ai/api/thelake";

export interface SoftprobeClientOptions extends Omit<SoftprobeConfig, "publicKey" | "baseUrl"> {
  /** Agent or project ingest key (`spk_...`). */
  publicKey?: string;
  /** Alias for `publicKey`. */
  apiKey?: string;
  /** Ingest API root. Defaults to `https://explorer.softprobe.ai/api/thelake`. */
  baseUrl?: string;
  /** Injected exporter for tests (skips OTLP setup). */
  spanExporter?: SpanExporter;
  /** Injected score transport for tests. */
  scoreTransport?: ScoreTransport;
  /** Use simple processor (tests) instead of batch. */
  useSimpleProcessor?: boolean;
  /** Batch processor tuning when `useSimpleProcessor` is false. */
  batchProcessor?: BufferConfig;
  /**
   * Retry transient OTLP export failures. Default true for real OTLP;
   * skipped when `spanExporter` is injected (tests).
   */
  retryExport?: boolean;
  /** Optional diagnostics. */
  enableDiag?: boolean;
  /**
   * Register this client's provider as the global OTEL provider.
   * Disable when sharing an application-owned NodeSDK / tracer.
   */
  registerProvider?: boolean;
  /** Disable the global tracer API on shutdown (only if this client registered it). */
  disableGlobalTracerOnShutdown?: boolean;
}

export class SoftprobeClient {
  private readonly provider: NodeTracerProvider;
  private readonly runtime: ObservationRuntime;
  private readonly scoreTransport: ScoreTransport;
  private readonly registeredProvider: boolean;
  private readonly disableGlobalTracerOnShutdown: boolean;
  private shutDown = false;

  /** Build from `SOFTPROBE_*` env. Defaults `baseUrl` to production TheLake when omitted. */
  static fromEnv(
    overrides: Partial<SoftprobeClientOptions> = {},
  ): SoftprobeClient {
    const cfg = resolveSoftprobeConfigFromEnv({
      ...process.env,
      SOFTPROBE_BASE_URL:
        process.env.SOFTPROBE_BASE_URL ||
        overrides.baseUrl ||
        DEFAULT_THELAKE_BASE_URL,
    });
    const overrideKey = (overrides.publicKey ?? overrides.apiKey)?.trim();
    if (!cfg && !overrideKey) {
      throw new MissingSoftprobeCredentialsError(
        "Set SOFTPROBE_PUBLIC_KEY (or SOFTPROBE_API_KEY)",
      );
    }
    return new SoftprobeClient({ ...(cfg ?? {}), ...overrides });
  }

  constructor(options: SoftprobeClientOptions) {
    const resolvedPublicKey = (options.publicKey ?? options.apiKey)?.trim();
    if (!resolvedPublicKey) {
      throw new Error("publicKey is required");
    }
    const rawBaseUrl =
      options.baseUrl === undefined ? DEFAULT_THELAKE_BASE_URL : options.baseUrl;
    if (!rawBaseUrl?.trim()) {
      throw new Error("baseUrl is required");
    }
    const baseUrl = rawBaseUrl.trim();
    const otlpEndpoint =
      options.otlpEndpoint?.trim() || deriveOtlpEndpoint(baseUrl);
    if (!options.spanExporter && !otlpEndpoint) {
      throw new Error("otlpEndpoint is required");
    }

    if (options.enableDiag) {
      diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);
    }

    const serviceName = options.serviceName ?? "softprobe-app";
    const resourceAttrs: Record<string, string> = {
      [ATTR_SERVICE_NAME]: serviceName,
      "telemetry.sdk.name": "softprobe",
    };
    if (options.serviceVersion) {
      resourceAttrs[ATTR_SERVICE_VERSION] = options.serviceVersion;
    }
    if (options.environment) {
      resourceAttrs["deployment.environment.name"] = options.environment;
    }

    const baseExporter =
      options.spanExporter ??
      new OTLPTraceExporter({
        url: otlpEndpoint,
        headers: {
          Authorization: `Bearer ${resolvedPublicKey}`,
          ...(options.headers ?? {}),
        },
        timeoutMillis: options.timeoutMs ?? 10_000,
      });
    const rawExporter: SpanExporter = {
      export(spans, resultCallback) {
        context.with(suppressTracing(ROOT_CONTEXT), () => {
          baseExporter.export(spans, resultCallback);
        });
      },
      shutdown: () => baseExporter.shutdown(),
      ...(typeof baseExporter.forceFlush === "function"
        ? { forceFlush: () => baseExporter.forceFlush!() }
        : {}),
    };
    // Real OTLP to thelake often times out once under load; retry instead of
    // dropping generations/tools while smaller event spans happen to land.
    const retryExport =
      options.retryExport ?? options.spanExporter === undefined;
    const exporter: SpanExporter = retryExport
      ? new RetryingSpanExporter(rawExporter, {
          // Keep retries inside BatchSpanProcessor exportTimeoutMillis.
          budgetMs: Math.max(
            5_000,
            (options.timeoutMs ?? 30_000) - 5_000,
          ),
        })
      : rawExporter;

    const processor: SpanProcessor = options.useSimpleProcessor
      ? new SimpleSpanProcessor(exporter)
      : new BatchSpanProcessor(exporter, {
          // Prefer fewer larger POSTs over one HTTP call per span end.
          scheduledDelayMillis: 500,
          maxExportBatchSize: 64,
          maxQueueSize: 2048,
          exportTimeoutMillis: options.timeoutMs ?? 30_000,
          ...(options.batchProcessor ?? {}),
        });

    this.provider = new NodeTracerProvider({
      resource: new Resource(resourceAttrs),
    });
    this.provider.addSpanProcessor(processor);
    this.registeredProvider = options.registerProvider ?? true;
    this.disableGlobalTracerOnShutdown =
      options.disableGlobalTracerOnShutdown ?? this.registeredProvider;
    if (this.registeredProvider) {
      this.provider.register();
    }

    this.runtime = {
      tracer: this.provider.getTracer("@softprobe/tracing", "0.1.0"),
      redactKeys: options.redactKeys ?? defaultRedactKeys(),
      sessionId: options.sessionId,
      userId: options.userId,
      release: options.release,
      tags: options.tags,
    };

    this.scoreTransport =
      options.scoreTransport ??
      new HttpScoreTransport(
        baseUrl,
        resolvedPublicKey,
        options.headers ?? {},
        options.timeoutMs ?? 10_000,
      );
  }

  get tracer() {
    return this.runtime.tracer;
  }

  startObservation(options: StartObservationOptions): Observation {
    this.assertActive();
    return startObservationSpan(this.runtime, options);
  }

  startGeneration(options: StartGenerationOptions): Generation {
    this.assertActive();
    return startGenerationSpan(this.runtime, {
      ...options,
      asType: "generation",
    });
  }

  startAgent(options: Omit<StartObservationOptions, "asType">): Observation {
    return this.startObservation({ ...options, asType: "agent" });
  }

  startTool(options: StartToolOptions): Observation {
    const {
      toolName,
      toolCallId,
      kind,
      status,
      index,
      mcpServer,
      mcpTool,
      attributes,
      ...rest
    } = options;
    return this.startObservation({
      ...rest,
      asType: "tool",
      attributes: {
        ...(attributes ?? {}),
        ...toolSpanAttributes({
          toolName: toolName ?? options.name,
          toolCallId,
          kind: kind ?? "function",
          status: status ?? "ok",
          index,
          mcpServer,
          mcpTool,
        }),
      },
    });
  }

  startChain(options: Omit<StartObservationOptions, "asType">): Observation {
    return this.startObservation({ ...options, asType: "chain" });
  }

  startRetriever(
    options: Omit<StartObservationOptions, "asType">,
  ): Observation {
    return this.startObservation({ ...options, asType: "retriever" });
  }

  startEvaluator(
    options: Omit<StartObservationOptions, "asType">,
  ): Observation {
    return this.startObservation({ ...options, asType: "evaluator" });
  }

  startEmbedding(
    options: Omit<StartObservationOptions, "asType">,
  ): Observation {
    return this.startObservation({ ...options, asType: "embedding" });
  }

  startGuardrail(
    options: Omit<StartObservationOptions, "asType">,
  ): Observation {
    return this.startObservation({ ...options, asType: "guardrail" });
  }

  startEvent(options: Omit<StartObservationOptions, "asType">): Observation {
    return this.startObservation({ ...options, asType: "event" });
  }

  async withObservation<T>(
    options: StartObservationOptions,
    fn: (observation: Observation) => Promise<T> | T,
  ): Promise<T> {
    const observation = this.startObservation(options);
    return withObservationContext(observation, fn);
  }

  async withGeneration<T>(
    options: StartGenerationOptions,
    fn: (generation: Generation) => Promise<T> | T,
  ): Promise<T> {
    const generation = this.startGeneration(options);
    return withObservationContext(
      generation,
      fn as (observation: Observation) => Promise<T> | T,
    );
  }

  withAttributes<T>(
    attributes: Parameters<typeof withAttributesFn>[0],
    fn: () => Promise<T> | T,
  ): Promise<T> | T {
    return withAttributesFn(attributes, fn);
  }

  observationType(type: ObservationType): ObservationType {
    return type;
  }

  async createScore(options: CreateScoreOptions): Promise<void> {
    this.assertActive();
    const request = buildScoreRequest(options);
    await this.scoreTransport.createScore(request);
  }

  async forceFlush(): Promise<void> {
    await this.provider.forceFlush();
  }

  /** Alias for {@link forceFlush}. */
  async flush(): Promise<void> {
    await this.forceFlush();
  }

  async shutdown(): Promise<void> {
    if (this.shutDown) return;
    this.shutDown = true;
    await this.provider.shutdown();
    if (this.disableGlobalTracerOnShutdown) {
      trace.disable();
    }
  }

  private assertActive(): void {
    if (this.shutDown) {
      throw new Error("SoftprobeClient has been shut down");
    }
  }
}
