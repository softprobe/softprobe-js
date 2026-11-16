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
  DEFAULT_THELAKE_BASE_URL,
  deriveOtlpEndpoint,
  mergeOtlpHeaders,
  MissingSoftprobeCredentialsError,
  resolveSoftprobeConfigFromEnv,
  validateOtlpProtocol,
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

export interface SoftprobeClientOptions extends SoftprobeConfig {
  /** Ingestion Key (`spk_...`). */
  ingestionKey?: string;
  /** @deprecated Use `ingestionKey`. */
  publicKey?: string;
  /** @deprecated Use `ingestionKey`. */
  apiKey?: string;
  /**
   * Score API base. Defaults to `https://explorer.softprobe.ai/api/thelake`;
   * also supplies the legacy trace endpoint fallback when no OTLP endpoint is set.
   */
  baseUrl?: string;
  /** Injected exporter for tests (skips OTLP setup). */
  spanExporter?: SpanExporter;
  /** Additional span processors registered before the exporter processor. */
  spanProcessors?: SpanProcessor[];
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

  /** Build from standard OTLP variables and Softprobe environment settings. */
  static fromEnv(
    overrides: Partial<SoftprobeClientOptions> = {},
  ): SoftprobeClient {
    const ingestionKey = (
      overrides.ingestionKey ?? overrides.apiKey ?? overrides.publicKey
    )?.trim();
    const baseUrl =
      overrides.baseUrl?.trim() ||
      process.env.SOFTPROBE_BASE_URL?.trim() ||
      DEFAULT_THELAKE_BASE_URL;
    const cfg = resolveSoftprobeConfigFromEnv({
      ...process.env,
      SOFTPROBE_BASE_URL: baseUrl,
      ...(ingestionKey ? { SOFTPROBE_PUBLIC_KEY: ingestionKey } : {}),
    });
    if (!cfg) {
      throw new MissingSoftprobeCredentialsError(
        "Set OTEL_EXPORTER_OTLP_HEADERS or OTEL_EXPORTER_OTLP_TRACES_HEADERS with the Ingestion Key, or pass ingestionKey",
      );
    }

    const explicitOtlp = overrides.otlp ?? {};
    const tracesEndpoint = explicitOtlp.tracesEndpoint ??
      overrides.otlpEndpoint ??
      (explicitOtlp.endpoint
        ? deriveOtlpEndpoint(explicitOtlp.endpoint)
        : cfg.otlp.tracesEndpoint);
    const otlp = {
      ...cfg.otlp,
      ...explicitOtlp,
      tracesEndpoint,
      protocol: explicitOtlp.protocol ?? cfg.otlp.protocol,
      headers: mergeOtlpHeaders(
        cfg.otlp.headers,
        explicitOtlp.headers,
        overrides.headers,
      ),
    };
    const resourceAttributes = {
      ...(cfg.resourceAttributes ?? {}),
      ...(overrides.resourceAttributes ?? {}),
    };
    if (
      overrides.serviceName &&
      overrides.resourceAttributes?.[ATTR_SERVICE_NAME] === undefined
    ) {
      resourceAttributes[ATTR_SERVICE_NAME] = overrides.serviceName;
    }
    if (
      overrides.environment &&
      overrides.resourceAttributes?.["deployment.environment.name"] === undefined
    ) {
      resourceAttributes["deployment.environment.name"] = overrides.environment;
    }

    return new SoftprobeClient({
      ...cfg,
      ...overrides,
      ingestionKey: ingestionKey ?? cfg.ingestionKey,
      baseUrl,
      otlp,
      otlpEndpoint: tracesEndpoint,
      resourceAttributes:
        Object.keys(resourceAttributes).length ? resourceAttributes : undefined,
    });
  }

  constructor(options: SoftprobeClientOptions) {
    const ingestionKey = (
      options.ingestionKey ?? options.apiKey ?? options.publicKey
    )?.trim();
    if (!ingestionKey) {
      throw new Error("ingestionKey is required");
    }
    const rawBaseUrl =
      options.baseUrl === undefined ? DEFAULT_THELAKE_BASE_URL : options.baseUrl;
    if (!rawBaseUrl?.trim()) {
      throw new Error("baseUrl is required");
    }
    const baseUrl = rawBaseUrl.trim();
    validateOtlpProtocol(options.otlp?.protocol);
    const otlpEndpoint = options.otlp?.tracesEndpoint?.trim() ||
      options.otlpEndpoint?.trim() ||
      deriveOtlpEndpoint(options.otlp?.endpoint ?? baseUrl);
    if (!options.spanExporter && !otlpEndpoint) {
      throw new Error("otlpEndpoint is required");
    }

    if (options.enableDiag) {
      diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);
    }

    const serviceName = options.serviceName ?? "softprobe-app";
    const resourceAttrs = {
      "telemetry.sdk.name": "softprobe",
      [ATTR_SERVICE_NAME]: serviceName,
      ...(options.serviceVersion
        ? { [ATTR_SERVICE_VERSION]: options.serviceVersion }
        : {}),
      ...(options.environment
        ? { "deployment.environment.name": options.environment }
        : {}),
      ...(options.resourceAttributes ?? {}),
    };

    const baseExporter =
      options.spanExporter ??
      new OTLPTraceExporter({
        url: otlpEndpoint,
        headers: mergeOtlpHeaders(
          options.otlp?.headers,
          options.headers,
          { Authorization: `Bearer ${ingestionKey}` },
        ),
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
    for (const extraProcessor of options.spanProcessors ?? []) {
      this.provider.addSpanProcessor(extraProcessor);
    }
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
        ingestionKey,
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
