import {
  mobile,
  test as mobileBaseTest,
  type DeviceLease,
  type DeviceProvider,
  type DeviceRequest,
  type MobileFixtures,
  type MobileOptions,
  type MobilePlatform,
} from "@e2e-dev/mobile";
import {
  mobileTools as rawMobileTools,
  unstable_deviceSession as rawUnstableDeviceSession,
} from "@e2e-dev/mobile/tools";
import { credentials, expect, secrets, unique } from "e2e";
import type { DefinedTool } from "@e2e-dev/core/agent";
import {
  ConfigurationError,
  defineEngine,
  type EngineAppInfo,
  type EngineAttemptContext,
  type EngineCleanupContext,
  type EngineDisposeContext,
  type EngineHandle,
  type EngineInitInfo,
} from "e2e/engine";
import {
  buildSinkFromResolved,
  createTraceScope,
  type SoftprobeTestFixtures,
} from "./fixtures.js";
import {
  attachEngineMetadata,
  clearActiveAttemptContext,
  clearActiveWorkerContext,
  registerTargetMetadata,
  resolveSinkConfig,
  setActiveAttemptContext,
  setActiveWorkerContext,
  splitSoftprobeWebOptions,
  type SoftprobeEngineMetadata,
} from "./internal/config.js";
import { BrowserAttemptLedger } from "./internal/correlator.js";
import {
  wrapEngineWithHostActionCapture,
  type HostActionAttemptBinding,
  type HostActionSinkDestination,
} from "./internal/host-action-exporter.js";
import {
  setupAndroidAdbReverse,
  startMobileProxy,
  type AdbReverseHandle,
  type MobileProxyHandle,
} from "./internal/mobile-proxy.js";
import { stageVerifiedTraceRecord } from "./internal/reporter.js";
import type { TraceSink } from "./internal/sink-shared.js";
import {
  createBlackboxSessionTriggerSource,
  createLedgerTriggerSource,
  type TriggerSource,
} from "./internal/trigger-source.js";
import {
  softprobeCachedAgent,
  type SoftprobeCachedAgentOptions,
} from "./session-compiler.js";
import type {
  SoftprobeSinkConfig,
  SoftprobeStoreMode,
  TraceScope,
} from "./types.js";

export {
  credentials,
  expect,
  secrets,
  softprobeCachedAgent,
  unique,
  type SoftprobeCachedAgentOptions,
};
export type {
  Device,
  DeviceLease,
  DeviceOrientation,
  DevicePermission,
  DeviceProvider,
  DeviceRequest,
  DeviceSession,
  ForegroundApp,
  LaunchPermissions,
  MobileFixtures,
  MobileOptions,
  MobilePlatform,
  PermissionState,
} from "@e2e-dev/mobile";
export type { SoftprobeTestFixtures, TraceScope };

export type SoftprobeMobileCorrelationConfig =
  | {
      readonly mode: "proxy";
      readonly upstreamOrigin: string;
      readonly launchArgKey?: string | undefined;
      readonly adbReverse?: boolean | undefined;
    }
  | {
      readonly mode: "session";
      readonly sessionId?: string | undefined;
      readonly launchArgKey?: string | undefined;
    };

export interface SoftprobeMobileOptions extends MobileOptions {
  readonly sink?: SoftprobeSinkConfig | undefined;
  readonly endpoint?: string | undefined;
  readonly token?: string | undefined;
  readonly workspaceId?: string | undefined;
  readonly tenantId?: string | undefined;
  readonly appId?: string | undefined;
  readonly store?: SoftprobeStoreMode | undefined;
  readonly explorerUrl?: string | undefined;
  readonly correlation?: SoftprobeMobileCorrelationConfig | undefined;
  readonly captureActions?: boolean | undefined;
  readonly secretSlots?: Readonly<Record<string, string>> | undefined;
  readonly serviceName?: string | undefined;
  readonly traceTimeoutMs?: number | undefined;
  readonly pollTimeoutMs?: number | undefined;
  readonly pollIntervalMs?: number | undefined;
  readonly settleMs?: number | undefined;
}

const APPLE_SIMULATOR_UDID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
const ANDROID_ADB_SERIAL_PATTERN = /^(?:emulator-\d+|[A-Za-z0-9._-]+:\d+)$/;

interface ActiveMobileRuntimeState {
  readonly platform: MobilePlatform;
  readonly correlation: SoftprobeMobileCorrelationConfig;
  readonly metadata: SoftprobeEngineMetadata;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly targetName: string;
  readonly runId: string;
  readonly projectRoot: string;
  readonly fetchImpl: typeof fetch | undefined;
  attemptId: string;
  artifactsDir: string;
  sessionId: string;
  ledger: BrowserAttemptLedger;
}

const baseMobileEngineMap = new WeakMap<EngineHandle, EngineHandle>();
let activeMobileRuntime: ActiveMobileRuntimeState | undefined;

function normalizeIosLaunchFlag(rawKey: string): string {
  const trimmed = rawKey.trim();
  return trimmed.startsWith("-") ? trimmed : `-${trimmed}`;
}

export function buildMobileCorrelationLaunchArguments(input: {
  readonly platform: MobilePlatform;
  readonly existingArgs: readonly string[] | undefined;
  readonly correlation: SoftprobeMobileCorrelationConfig;
  readonly proxyOrigin: string | undefined;
  readonly sessionId: string;
}): readonly string[] {
  const base = [...(input.existingArgs ?? [])];

  if (input.platform === "android") {
    const key =
      input.correlation.mode === "proxy"
        ? input.correlation.launchArgKey?.trim() || "api_base_url"
        : input.correlation.launchArgKey?.trim() || "sp_session_id";
    const value =
      input.correlation.mode === "proxy" ? (input.proxyOrigin ?? "") : input.sessionId;
    if (value === "") return base;

    const cleaned: string[] = [];
    for (let i = 0; i < base.length; i += 1) {
      const token = base[i]!;
      if (token === "--es" && base[i + 1] === key && i + 2 < base.length) {
        i += 2;
        continue;
      }
      cleaned.push(token);
    }
    cleaned.push("--es", key, value);
    return cleaned;
  }

  const defaultIosKey =
    input.correlation.mode === "proxy" ? "API_BASE_URL" : "spSessionId";
  const flag = normalizeIosLaunchFlag(
    input.correlation.launchArgKey?.trim() || defaultIosKey,
  );
  const value =
    input.correlation.mode === "proxy" ? (input.proxyOrigin ?? "") : input.sessionId;
  if (value === "") return base;

  const cleaned: string[] = [];
  for (let i = 0; i < base.length; i += 1) {
    const token = base[i]!;
    if (token === flag && i + 1 < base.length) {
      i += 1;
      continue;
    }
    cleaned.push(token);
  }
  cleaned.push(flag, value);
  return cleaned;
}

function validateMobileCorrelation(
  correlation: SoftprobeMobileCorrelationConfig | undefined,
): SoftprobeMobileCorrelationConfig {
  if (correlation === undefined) {
    return { mode: "session" };
  }
  if (typeof correlation !== "object" || correlation === null) {
    throw new ConfigurationError(
      "INVALID_CONFIG",
      "softprobeMobile({ correlation }) must be a correlation configuration object",
    );
  }
  if (correlation.mode === "proxy") {
    if (
      typeof correlation.upstreamOrigin !== "string" ||
      correlation.upstreamOrigin.trim() === ""
    ) {
      throw new ConfigurationError(
        "INVALID_CONFIG",
        'softprobeMobile({ correlation: { mode: "proxy" } }) requires a non-empty upstreamOrigin',
      );
    }
    try {
      const parsed = new URL(correlation.upstreamOrigin.trim());
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("invalid protocol");
      }
    } catch {
      throw new ConfigurationError(
        "INVALID_CONFIG",
        `Invalid upstreamOrigin in softprobeMobile correlation: ${JSON.stringify(correlation.upstreamOrigin)}`,
      );
    }
    return correlation;
  }
  if (correlation.mode === "session") {
    if (
      correlation.sessionId !== undefined &&
      (typeof correlation.sessionId !== "string" || correlation.sessionId.trim() === "")
    ) {
      throw new ConfigurationError(
        "INVALID_CONFIG",
        'softprobeMobile({ correlation: { mode: "session" } }) sessionId must be a non-empty string when set',
      );
    }
    return correlation;
  }
  const _exhaustive: never = correlation;
  throw new ConfigurationError(
    "INVALID_CONFIG",
    `Unsupported softprobeMobile correlation mode: ${JSON.stringify(_exhaustive)}`,
  );
}

function isAndroidSerialCandidate(deviceSpec: string): boolean {
  return ANDROID_ADB_SERIAL_PATTERN.test(deviceSpec.trim());
}

function createLocalDeviceLeaseProvider(
  platform: MobilePlatform,
  deviceNames: readonly string[],
): DeviceProvider {
  return {
    name: "softprobe-local-device",
    async acquire(request: DeviceRequest): Promise<DeviceLease> {
      const rawSpec = deviceNames[request.slot] ?? deviceNames[0] ?? "";
      const spec = rawSpec.trim();
      const stateDir = request.env.AGENT_DEVICE_STATE_DIR?.trim();
      const client = stateDir ? { stateDir } : {};
      const bindAsId =
        platform === "android"
          ? isAndroidSerialCandidate(spec)
          : APPLE_SIMULATOR_UDID.test(spec);
      return {
        id: `local-${request.slot}-${spec || "default"}`,
        ...(spec === ""
          ? {}
          : bindAsId
            ? { deviceId: spec }
            : { device: spec }),
        client,
      };
    },
    async release(): Promise<void> {
      return;
    },
  };
}

function normalizeMobileDeviceOption(
  platform: MobilePlatform,
  device: MobileOptions["device"],
): {
  readonly normalizedDevice: MobileOptions["device"];
  readonly explicitSerials: readonly string[];
  readonly maxWorkers: number | undefined;
} {
  if (typeof device === "string") {
    const trimmed = device.trim();
    if (trimmed === "") {
      return { normalizedDevice: device, explicitSerials: [], maxWorkers: undefined };
    }
    const needsLeaseAdapter =
      (platform === "android" && isAndroidSerialCandidate(trimmed)) ||
      Boolean(process.env.AGENT_DEVICE_STATE_DIR?.trim());
    return {
      normalizedDevice: needsLeaseAdapter
        ? createLocalDeviceLeaseProvider(platform, [trimmed])
        : trimmed,
      explicitSerials: platform === "android" && isAndroidSerialCandidate(trimmed) ? [trimmed] : [],
      maxWorkers: 1,
    };
  }

  if (Array.isArray(device)) {
    const nonEmpty = device
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item !== "");
    const anySerial =
      platform === "android" && nonEmpty.some((item) => isAndroidSerialCandidate(item));
    const needsLeaseAdapter =
      anySerial || Boolean(process.env.AGENT_DEVICE_STATE_DIR?.trim());
    return {
      normalizedDevice:
        needsLeaseAdapter && nonEmpty.length > 0
          ? createLocalDeviceLeaseProvider(platform, nonEmpty)
          : device,
      explicitSerials:
        platform === "android"
          ? nonEmpty.filter((item) => isAndroidSerialCandidate(item))
          : [],
      maxWorkers: nonEmpty.length > 0 ? nonEmpty.length : undefined,
    };
  }

  return {
    normalizedDevice: device,
    explicitSerials: [],
    maxWorkers: undefined,
  };
}

function splitSoftprobeMobileOptions(options: SoftprobeMobileOptions): {
  readonly mobileOptions: MobileOptions;
  readonly metadata: SoftprobeEngineMetadata;
  readonly correlation: SoftprobeMobileCorrelationConfig;
  readonly explicitSerials: readonly string[];
  readonly maxWorkers: number | undefined;
} {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new ConfigurationError(
      "INVALID_CONFIG",
      "softprobeMobile(options) requires a plain options object",
    );
  }
  if (options.platform !== "ios" && options.platform !== "android") {
    throw new ConfigurationError(
      "INVALID_CONFIG",
      `softprobeMobile() requires platform: "ios" or "android", got ${JSON.stringify(options.platform)}`,
    );
  }

  const correlation = validateMobileCorrelation(options.correlation);
  const { metadata } = splitSoftprobeWebOptions({
    ...(options.sink !== undefined ? { sink: options.sink } : {}),
    ...(options.endpoint !== undefined ? { endpoint: options.endpoint } : {}),
    ...(options.token !== undefined ? { token: options.token } : {}),
    ...(options.workspaceId !== undefined ? { workspaceId: options.workspaceId } : {}),
    ...(options.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
    ...(options.appId !== undefined ? { appId: options.appId } : {}),
    ...(options.store !== undefined ? { store: options.store } : {}),
    ...(options.explorerUrl !== undefined ? { explorerUrl: options.explorerUrl } : {}),
    ...(options.traceTimeoutMs !== undefined ? { traceTimeoutMs: options.traceTimeoutMs } : {}),
    ...(options.pollTimeoutMs !== undefined ? { pollTimeoutMs: options.pollTimeoutMs } : {}),
    ...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {}),
    ...(options.settleMs !== undefined ? { settleMs: options.settleMs } : {}),
  });

  const { normalizedDevice, explicitSerials, maxWorkers } = normalizeMobileDeviceOption(
    options.platform,
    options.device,
  );

  const {
    sink: _sink,
    endpoint: _endpoint,
    token: _token,
    workspaceId: _workspaceId,
    tenantId: _tenantId,
    appId: _appId,
    store: _store,
    explorerUrl: _explorerUrl,
    correlation: _correlation,
    captureActions: _captureActions,
    secretSlots: _secretSlots,
    serviceName: _serviceName,
    traceTimeoutMs: _traceTimeoutMs,
    pollTimeoutMs: _pollTimeoutMs,
    pollIntervalMs: _pollIntervalMs,
    settleMs: _settleMs,
    device: _rawDevice,
    ...restMobileOptions
  } = options;

  const mobileOptions: MobileOptions = {
    ...restMobileOptions,
    ...(normalizedDevice === undefined ? {} : { device: normalizedDevice }),
  };

  return {
    mobileOptions,
    metadata,
    correlation,
    explicitSerials,
    maxWorkers,
  };
}

function resolveActionExportDestination(
  options: SoftprobeMobileOptions,
  env: Readonly<Record<string, string | undefined>>,
): HostActionSinkDestination | undefined {
  const hasExplicitEndpoint = Boolean(
    options.sink !== undefined ||
      options.endpoint?.trim() ||
      env.SOFTPROBE_SINK_ENDPOINT?.trim() ||
      env.SOFTPROBE_TRACE_ENDPOINT?.trim() ||
      env.SOFTPROBE_URL?.trim() ||
      env.SP_API_URL?.trim() ||
      env.SOFTPROBE_BASE_URL?.trim() ||
      env.THELAKE_URL?.trim() ||
      env.SOFTPROBE_API_KEY?.trim() ||
      env.SOFTPROBE_TOKEN?.trim() ||
      env.SP_TOKEN?.trim() ||
      env.INGESTION_KEY?.trim(),
  );
  if (!hasExplicitEndpoint) {
    return undefined;
  }

  try {
    const resolved = resolveSinkConfig(
      {
        ...(options.sink !== undefined ? { sink: options.sink } : {}),
        ...(options.endpoint !== undefined ? { endpoint: options.endpoint } : {}),
        ...(options.token !== undefined ? { token: options.token } : {}),
        ...(options.workspaceId !== undefined ? { workspaceId: options.workspaceId } : {}),
        ...(options.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
        ...(options.appId !== undefined ? { appId: options.appId } : {}),
        ...(options.store !== undefined ? { store: options.store } : {}),
        ...(options.explorerUrl !== undefined ? { explorerUrl: options.explorerUrl } : {}),
      },
      env,
    );
    if (resolved.kind !== "blackbox") {
      return undefined;
    }
    return {
      endpoint: resolved.endpoint,
      token: resolved.token,
      workspaceId: resolved.workspaceId,
      serviceName: options.serviceName,
    };
  } catch {
    return undefined;
  }
}

function resolveAndroidSerialForSlot(
  explicitSerials: readonly string[],
  workerSlot: number,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const fromSlot = explicitSerials[workerSlot] ?? explicitSerials[0];
  if (fromSlot && fromSlot.trim() !== "") {
    return fromSlot.trim();
  }
  const fromEnv =
    env.SP_ANDROID_ADB_TARGET?.trim() ||
    env.ANDROID_SERIAL?.trim() ||
    undefined;
  return fromEnv;
}

export interface WrapMobileEngineInternalHooks {
  readonly fetchImpl?: typeof fetch | undefined;
  readonly runAdbCommand?: ((file: string, args: readonly string[]) => void) | undefined;
}

export function wrapMobileEngine(
  baseEngine: EngineHandle<MobileFixtures>,
  options: SoftprobeMobileOptions,
  hooks: WrapMobileEngineInternalHooks = {},
): EngineHandle<MobileFixtures> {
  const { metadata, correlation, explicitSerials, maxWorkers } =
    splitSoftprobeMobileOptions(options);

  let workerProxy: MobileProxyHandle | undefined;
  let adbReverseHandle: AdbReverseHandle | undefined;
  let currentAttemptBinding: HostActionAttemptBinding | undefined;

  const { engine: actionCapturedEngine, exporter } = wrapEngineWithHostActionCapture(
    baseEngine,
    {
      platform: options.platform,
      enabled: options.captureActions !== false,
      fetchImpl: hooks.fetchImpl,
      resolveAttemptBinding: () => currentAttemptBinding,
    },
  );

  const effectiveWorkers = baseEngine.workers ?? maxWorkers;

  const lifecycleWrapped = defineEngine<MobileFixtures>({
    name: actionCapturedEngine.name,
    version: actionCapturedEngine.version,
    spiVersion: actionCapturedEngine.spiVersion,
    ...(actionCapturedEngine.platform === undefined
      ? {}
      : { platform: actionCapturedEngine.platform }),
    ...(effectiveWorkers === undefined ? {} : { workers: effectiveWorkers }),
    ...(actionCapturedEngine.secrets === undefined
      ? {}
      : { secrets: actionCapturedEngine.secrets }),
    ...(actionCapturedEngine.prepare === undefined
      ? {}
      : { prepare: (info) => actionCapturedEngine.prepare!(info) }),
    ...(actionCapturedEngine.finish === undefined
      ? {}
      : { finish: (info) => actionCapturedEngine.finish!(info) }),
    ...(actionCapturedEngine.doctor === undefined
      ? {}
      : { doctor: (info) => actionCapturedEngine.doctor!(info) }),
    init: async (info: EngineInitInfo) => {
      const initialLedger = new BrowserAttemptLedger();
      const initialSessionId =
        correlation.mode === "session" && correlation.sessionId
          ? correlation.sessionId.trim()
          : `sp-e2e-${info.runId}-${info.workerSlot}`;

      if (correlation.mode === "proxy") {
        workerProxy = await startMobileProxy({
          upstreamOrigin: correlation.upstreamOrigin,
          ledger: initialLedger,
          sessionId: initialSessionId,
          onResponse: (completed) => {
            if (completed.status !== undefined) {
              exporter.recordResponseStatus(completed.spanId, completed.status);
            }
          },
        });
      }

      try {
        activeMobileRuntime = {
          platform: options.platform,
          correlation,
          metadata,
          env: info.env,
          targetName: info.targetName,
          runId: info.runId,
          projectRoot: info.projectRoot,
          fetchImpl: hooks.fetchImpl,
          attemptId: "init",
          artifactsDir: info.projectRoot,
          sessionId: initialSessionId,
          ledger: initialLedger,
        };

        setActiveWorkerContext({
          targetName: info.targetName,
          runId: info.runId,
          projectRoot: info.projectRoot,
          env: info.env,
          appOrigin:
            correlation.mode === "proxy" ? correlation.upstreamOrigin : info.app.origin,
          metadata,
        });

        const baseApp = info.app;
        const patchedApp: EngineAppInfo = {
          ...baseApp,
          get launchArguments(): readonly string[] {
            const activeSession = activeMobileRuntime?.sessionId ?? initialSessionId;
            return buildMobileCorrelationLaunchArguments({
              platform: options.platform,
              existingArgs: baseApp.launchArguments,
              correlation,
              proxyOrigin: workerProxy?.proxyOrigin,
              sessionId: activeSession,
            });
          },
        };

        await actionCapturedEngine.init?.({
          ...info,
          app: patchedApp,
        });

        if (
          correlation.mode === "proxy" &&
          options.platform === "android" &&
          correlation.adbReverse !== false &&
          workerProxy !== undefined
        ) {
          const serial = resolveAndroidSerialForSlot(
            explicitSerials,
            info.workerSlot,
            info.env,
          );
          adbReverseHandle = setupAndroidAdbReverse({
            port: workerProxy.port,
            serial,
            env: info.env,
            runCommand: hooks.runAdbCommand,
          });
        }
      } catch (error) {
        adbReverseHandle?.cleanup();
        adbReverseHandle = undefined;
        await workerProxy?.close();
        workerProxy = undefined;
        activeMobileRuntime = undefined;
        clearActiveWorkerContext(info.targetName);
        throw error;
      }
    },
    startAttempt: async (context: EngineAttemptContext) => {
      const attemptLedger = new BrowserAttemptLedger();
      const attemptSessionId =
        correlation.mode === "session" && correlation.sessionId
          ? correlation.sessionId.trim()
          : `sp-e2e-${context.attemptId}`;

      setActiveAttemptContext({
        attemptId: context.attemptId,
        artifactsDir: context.artifactsDir,
      });

      const activeEnv = activeMobileRuntime?.env ?? process.env;
      if (activeMobileRuntime !== undefined) {
        activeMobileRuntime.attemptId = context.attemptId;
        activeMobileRuntime.artifactsDir = context.artifactsDir;
        activeMobileRuntime.sessionId = attemptSessionId;
        activeMobileRuntime.ledger = attemptLedger;
      }

      if (workerProxy !== undefined) {
        workerProxy.setAttemptContext({
          ledger: attemptLedger,
          sessionId: attemptSessionId,
          onResponse: (completed) => {
            if (completed.status !== undefined) {
              exporter.recordResponseStatus(completed.spanId, completed.status);
            }
          },
        });
      }

      currentAttemptBinding = {
        sessionId: attemptSessionId,
        ledger: correlation.mode === "proxy" ? attemptLedger : undefined,
        sink: resolveActionExportDestination(options, activeEnv),
        env: activeEnv,
        secretSlots: options.secretSlots,
      };

      await actionCapturedEngine.startAttempt?.(context);
    },
    ...(actionCapturedEngine.settleAttempt === undefined
      ? {}
      : {
          settleAttempt: (context: EngineCleanupContext) =>
            actionCapturedEngine.settleAttempt!(context),
        }),
    endAttempt: async (context: EngineCleanupContext) => {
      try {
        await actionCapturedEngine.endAttempt?.(context);
      } finally {
        currentAttemptBinding = undefined;
        clearActiveAttemptContext();
      }
    },
    dispose: async (context: EngineDisposeContext) => {
      try {
        await actionCapturedEngine.dispose?.(context);
      } finally {
        adbReverseHandle?.cleanup();
        adbReverseHandle = undefined;
        await workerProxy?.close();
        workerProxy = undefined;
        currentAttemptBinding = undefined;
        activeMobileRuntime = undefined;
        clearActiveWorkerContext();
      }
    },
    ...(actionCapturedEngine.observe === undefined
      ? {}
      : {
          observe: (operation, observeOptions) =>
            actionCapturedEngine.observe!(operation, observeOptions),
        }),
    ...(actionCapturedEngine.readStyle === undefined
      ? {}
      : {
          readStyle: (ref, properties, operation) =>
            actionCapturedEngine.readStyle!(ref, properties, operation),
        }),
    ...(actionCapturedEngine.locate === undefined
      ? {}
      : {
          locate: (expression, operation) =>
            actionCapturedEngine.locate!(expression, operation),
        }),
    ...(actionCapturedEngine.perform === undefined
      ? {}
      : {
          perform: (ref, action, operation) =>
            actionCapturedEngine.perform!(ref, action, operation),
        }),
    ...(actionCapturedEngine.actions === undefined
      ? {}
      : { actions: actionCapturedEngine.actions }),
    ...(actionCapturedEngine.tapModifiers === undefined
      ? {}
      : { tapModifiers: actionCapturedEngine.tapModifiers }),
    ...(actionCapturedEngine.performAt === undefined
      ? {}
      : {
          performAt: (point, action, operation) =>
            actionCapturedEngine.performAt!(point, action, operation),
        }),
    ...(actionCapturedEngine.pointerActions === undefined
      ? {}
      : { pointerActions: actionCapturedEngine.pointerActions }),
    ...(actionCapturedEngine.keyboard === undefined
      ? {}
      : { keyboard: actionCapturedEngine.keyboard }),
    validateApp: (app, info) => {
      registerTargetMetadata(info.targetName, metadata);
      actionCapturedEngine.validateApp?.(app, info);
    },
    ...(actionCapturedEngine.session === undefined
      ? {}
      : { session: actionCapturedEngine.session }),
    ...(actionCapturedEngine.artifacts === undefined
      ? {}
      : { artifacts: actionCapturedEngine.artifacts }),
    ...(actionCapturedEngine.state === undefined
      ? {}
      : { state: actionCapturedEngine.state }),
    ...(actionCapturedEngine.isolation === undefined
      ? {}
      : { isolation: actionCapturedEngine.isolation }),
    fixtures: {
      device: (context) => {
        const deviceFactory = actionCapturedEngine.fixtures?.["device"];
        if (typeof deviceFactory !== "function") {
          throw new ConfigurationError(
            "INVALID_CONFIG",
            "Expected mobile engine to expose a device fixture factory",
          );
        }
        return deviceFactory(context) as MobileFixtures["device"];
      },
    },
  });

  attachEngineMetadata(lifecycleWrapped, metadata);
  baseMobileEngineMap.set(lifecycleWrapped, baseEngine);
  return lifecycleWrapped;
}

export function softprobeMobile(
  options: SoftprobeMobileOptions,
): EngineHandle<MobileFixtures> {
  const { mobileOptions } = splitSoftprobeMobileOptions(options);
  const base = mobile(mobileOptions);
  return wrapMobileEngine(base, options);
}

function unwrapEngineTuple(
  engines: readonly [EngineHandle, ...EngineHandle[]],
): [EngineHandle, ...EngineHandle[]] {
  const [first, ...rest] = engines;
  return [
    baseMobileEngineMap.get(first) ?? first,
    ...rest.map((engine) => baseMobileEngineMap.get(engine) ?? engine),
  ];
}

export function mobileTools(
  ...engines: readonly [EngineHandle, ...EngineHandle[]]
): Readonly<Record<string, DefinedTool>> {
  return rawMobileTools(...unwrapEngineTuple(engines));
}

export function unstable_deviceSession(
  ...engines: readonly [EngineHandle, ...EngineHandle[]]
) {
  return rawUnstableDeviceSession(...unwrapEngineTuple(engines));
}

export const test = mobileBaseTest.extend<SoftprobeTestFixtures>({
  trace: [
    async ({}, use) => {
      const runtime = activeMobileRuntime;
      if (runtime === undefined) {
        throw new ConfigurationError(
          "INVALID_CONFIG",
          "`trace` fixture from `@softprobe/e2e/mobile` requires a target configured with `softprobeMobile(...)`",
        );
      }

      let cachedSink: TraceSink | undefined;
      const resolveSink = (): TraceSink => {
        cachedSink ??= buildSinkFromResolved(runtime.metadata.rawOptions, runtime.env);
        return cachedSink;
      };

      const buildTriggerSource = (): TriggerSource => {
        if (runtime.correlation.mode === "proxy") {
          return createLedgerTriggerSource(runtime.ledger);
        }
        const sinkConfig = resolveSinkConfig(runtime.metadata.rawOptions, runtime.env);
        if (sinkConfig.kind !== "blackbox") {
          throw new ConfigurationError(
            "INVALID_CONFIG",
            'softprobeMobile({ correlation: { mode: "session" } }) requires a Blackbox sink configuration',
          );
        }
        return createBlackboxSessionTriggerSource({
          endpoint: sinkConfig.endpoint,
          sessionId: runtime.sessionId,
          token: sinkConfig.token,
          workspaceId: sinkConfig.workspaceId,
          fetchImpl: runtime.fetchImpl,
        });
      };

      const abortController = new AbortController();
      const scope = createTraceScope({
        triggerSource: buildTriggerSource(),
        resolveSink,
        pollingDefaults: runtime.metadata.polling,
        signal: abortController.signal,
        onVerifiedTrace: (event) => {
          stageVerifiedTraceRecord({
            runId: runtime.runId,
            projectRoot: runtime.projectRoot,
            targetName: runtime.targetName,
            attemptId: runtime.attemptId,
            artifactsDir: runtime.artifactsDir,
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
