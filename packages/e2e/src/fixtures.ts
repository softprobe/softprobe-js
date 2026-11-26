import {
  test as webTest,
  web,
  type Browser,
  type WebFixtures,
} from "@e2e-dev/web";
import {
  ConfigurationError,
  defineEngine,
  type EngineFixtureContext,
  type EngineHandle,
} from "e2e/engine";
import { ArexSink } from "./internal/arex-sink.js";
import { BlackboxSink } from "./internal/blackbox-sink.js";
import {
  attachEngineMetadata,
  clearActiveAttemptContext,
  clearActiveWorkerContext,
  registerTargetMetadata,
  resolveCurrentAttemptMetadata,
  resolveSinkConfig,
  setActiveAttemptContext,
  setActiveWorkerContext,
  splitSoftprobeWebOptions,
} from "./internal/config.js";
import {
  BrowserAttemptLedger,
  buildApiRoutePatterns,
  type TriggerLedgerView,
} from "./internal/correlator.js";
import {
  pollExpectNoOutboundHttp,
  pollOutboundHttp,
  type VerifiedTraceEvent,
} from "./internal/poller.js";
import { stageVerifiedTraceRecord } from "./internal/reporter.js";
import type { TraceSink } from "./internal/sink-shared.js";
import type {
  ExpectNoOutboundHttpQuery,
  OutboundHttpCall,
  OutboundHttpQuery,
  SoftprobeWebOptions,
  TraceScope,
} from "./types.js";

export interface SoftprobeTestFixtures {
  readonly trace: TraceScope;
}

function isBrowserFixture(value: unknown): value is Browser {
  return (
    typeof value === "object" &&
    value !== null &&
    "route" in value &&
    typeof value.route === "function"
  );
}

export function softprobeWeb(
  options: SoftprobeWebOptions = {},
): EngineHandle<WebFixtures> {
  const { webOptions, metadata } = splitSoftprobeWebOptions(options);
  const base = web(webOptions);
  const baseBrowserFactory = base.fixtures?.["browser"];
  if (typeof baseBrowserFactory !== "function") {
    throw new ConfigurationError(
      "INVALID_CONFIG",
      "Expected @e2e-dev/web engine to expose a browser fixture factory",
    );
  }

  const wrapped = defineEngine<WebFixtures>({
    name: base.name,
    version: base.version,
    spiVersion: base.spiVersion,
    ...(base.platform === undefined ? {} : { platform: base.platform }),
    ...(base.workers === undefined ? {} : { workers: base.workers }),
    ...(base.prepare === undefined ? {} : { prepare: (info) => base.prepare!(info) }),
    ...(base.finish === undefined ? {} : { finish: (info) => base.finish!(info) }),
    ...(base.doctor === undefined ? {} : { doctor: (info) => base.doctor!(info) }),
    init: async (info) => {
      setActiveWorkerContext({
        targetName: info.targetName,
        runId: info.runId,
        projectRoot: info.projectRoot,
        env: info.env,
        appOrigin: info.app.origin,
        metadata,
      });
      await base.init?.(info);
    },
    startAttempt: async (context) => {
      setActiveAttemptContext({
        attemptId: context.attemptId,
        artifactsDir: context.artifactsDir,
      });
      await base.startAttempt?.(context);
    },
    ...(base.settleAttempt === undefined
      ? {}
      : { settleAttempt: (context) => base.settleAttempt!(context) }),
    endAttempt: async (context) => {
      try {
        await base.endAttempt?.(context);
      } finally {
        clearActiveAttemptContext();
      }
    },
    dispose: async (context) => {
      try {
        await base.dispose?.(context);
      } finally {
        clearActiveWorkerContext();
      }
    },
    ...(base.observe === undefined
      ? {}
      : { observe: (operation, observeOptions) => base.observe!(operation, observeOptions) }),
    ...(base.readStyle === undefined
      ? {}
      : {
          readStyle: (ref, properties, operation) =>
            base.readStyle!(ref, properties, operation),
        }),
    ...(base.locate === undefined
      ? {}
      : { locate: (expression, operation) => base.locate!(expression, operation) }),
    ...(base.perform === undefined
      ? {}
      : { perform: (ref, action, operation) => base.perform!(ref, action, operation) }),
    ...(base.actions === undefined ? {} : { actions: base.actions }),
    ...(base.tapModifiers === undefined ? {} : { tapModifiers: base.tapModifiers }),
    ...(base.performAt === undefined
      ? {}
      : {
          performAt: (point, action, operation) =>
            base.performAt!(point, action, operation),
        }),
    ...(base.pointerActions === undefined
      ? {}
      : { pointerActions: base.pointerActions }),
    ...(base.keyboard === undefined ? {} : { keyboard: base.keyboard }),
    validateApp: (app, info) => {
      registerTargetMetadata(info.targetName, metadata);
      base.validateApp?.(app, info);
    },
    ...(base.secrets === undefined ? {} : { secrets: base.secrets }),
    ...(base.session === undefined ? {} : { session: base.session }),
    ...(base.artifacts === undefined ? {} : { artifacts: base.artifacts }),
    ...(base.state === undefined ? {} : { state: base.state }),
    ...(base.isolation === undefined ? {} : { isolation: base.isolation }),
    fixtures: {
      browser: (context: EngineFixtureContext): Browser => {
        const created = baseBrowserFactory(context);
        if (!isBrowserFixture(created)) {
          throw new ConfigurationError(
            "INVALID_CONFIG",
            "Expected @e2e-dev/web browser fixture factory to return a Browser surface",
          );
        }
        return created;
      },
    },
  });

  attachEngineMetadata(wrapped, metadata);
  return wrapped;
}

export function buildSinkFromResolved(
  options: SoftprobeWebOptions,
  env: Readonly<Record<string, string | undefined>>,
): TraceSink {
  const sinkConfig = resolveSinkConfig(options, env);
  if (sinkConfig.kind === "blackbox") {
    return new BlackboxSink({
      endpoint: sinkConfig.endpoint,
      softprobeApiKey: sinkConfig.softprobeApiKey,
      workspaceId: sinkConfig.workspaceId,
      explorerUrl: sinkConfig.explorerUrl,
    });
  }
  if (sinkConfig.kind === "arex") {
    return new ArexSink({
      endpoint: sinkConfig.endpoint,
      appId: sinkConfig.appId,
      token: sinkConfig.token,
      tenantId: sinkConfig.tenantId,
      explorerUrl: sinkConfig.explorerUrl,
    });
  }
  const _exhaustive: never = sinkConfig;
  return _exhaustive;
}

export function createTraceScope(options: {
  readonly ledger: BrowserAttemptLedger;
  readonly ledgerView: TriggerLedgerView;
  readonly resolveSink: () => TraceSink;
  readonly onVerifiedTrace?: (event: VerifiedTraceEvent) => void;
  readonly pollingDefaults: {
    readonly pollTimeoutMs: number;
    readonly pollIntervalMs: number;
    readonly settleMs: number;
  };
  readonly signal: AbortSignal;
}): TraceScope {
  return {
    async window(fn: () => Promise<void>): Promise<TraceScope> {
      const childView = await options.ledger.captureWindow(fn);
      return createTraceScope({
        ...options,
        ledgerView: childView,
      });
    },

    async outboundHttp(query: OutboundHttpQuery): Promise<OutboundHttpCall> {
      const sink = options.resolveSink();
      return pollOutboundHttp(
        {
          ledgerView: options.ledgerView,
          sink,
          defaults: options.pollingDefaults,
          signal: options.signal,
          onVerifiedTrace: options.onVerifiedTrace,
        },
        query,
      );
    },

    async expectNoOutboundHttp(query?: ExpectNoOutboundHttpQuery): Promise<void> {
      const sink = options.resolveSink();
      return pollExpectNoOutboundHttp(
        {
          ledgerView: options.ledgerView,
          sink,
          defaults: options.pollingDefaults,
          signal: options.signal,
          onVerifiedTrace: options.onVerifiedTrace,
        },
        query,
      );
    },
  };
}

export const test = webTest.extend<SoftprobeTestFixtures>({
  trace: [
    async ({ browser, app }, use) => {
      const current = resolveCurrentAttemptMetadata();
      const ledger = new BrowserAttemptLedger();
      const patterns = buildApiRoutePatterns(
        app.baseUrl,
        current.metadata.apiOrigins,
      );

      for (const pattern of patterns) {
        await browser.route(pattern, (route) => ledger.handleRoute(route));
      }

      let cachedSink: TraceSink | undefined;
      const resolveSink = (): TraceSink => {
        cachedSink ??= buildSinkFromResolved(
          current.metadata.rawOptions,
          current.env,
        );
        return cachedSink;
      };

      const abortController = new AbortController();
      const scope = createTraceScope({
        ledger,
        ledgerView: ledger.rootView,
        resolveSink,
        pollingDefaults: current.metadata.polling,
        signal: abortController.signal,
        onVerifiedTrace: (event) => {
          stageVerifiedTraceRecord({
            runId: current.runId,
            projectRoot: current.projectRoot,
            targetName: current.targetName,
            attemptId: current.attemptId,
            artifactsDir: current.artifactsDir,
            event,
          });
        },
      });

      try {
        await use(scope);
      } finally {
        abortController.abort();
      }
    },
    { scope: "test", auto: true },
  ],
});

export const { describe, beforeEach, afterEach, beforeAll, afterAll } = test;
