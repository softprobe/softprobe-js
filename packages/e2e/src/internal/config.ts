import type { WebOptions } from "@e2e-dev/web";
import { ConfigurationError } from "e2e/engine";
import type {
  SoftprobeSinkConfig,
  SoftprobeStoreMode,
  SoftprobeWebOptions,
} from "../types.js";

export const DEFAULT_POLL_TIMEOUT_MS = 30_000;
export const DEFAULT_POLL_INTERVAL_MS = 250;
export const DEFAULT_SETTLE_MS = 150;
export const DEFAULT_BLACKBOX_ENDPOINT = "https://explorer.softprobe.ai/api/thelake";

const SOFTPROBE_OPTION_KEYS = new Set<string>([
  "sink",
  "endpoint",
  "token",
  "workspaceId",
  "tenantId",
  "appId",
  "store",
  "explorerUrl",
  "apiOrigins",
  "traceTimeoutMs",
  "pollTimeoutMs",
  "pollIntervalMs",
  "settleMs",
]);

export interface SoftprobePollingDefaults {
  readonly pollTimeoutMs: number;
  readonly pollIntervalMs: number;
  readonly settleMs: number;
}

export interface SoftprobeEngineMetadata {
  readonly rawOptions: SoftprobeWebOptions;
  readonly apiOrigins: readonly (string | RegExp)[] | undefined;
  readonly polling: SoftprobePollingDefaults;
}

export interface ActiveWorkerContext {
  readonly targetName: string;
  readonly runId: string;
  readonly projectRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly appOrigin: string | undefined;
  readonly metadata: SoftprobeEngineMetadata;
}

export interface ActiveAttemptContext {
  readonly attemptId: string;
  readonly artifactsDir: string;
}

const engineMetadataMap = new WeakMap<object, SoftprobeEngineMetadata>();
const targetMetadataByName = new Map<string, SoftprobeEngineMetadata>();
let latestRegisteredMetadata: SoftprobeEngineMetadata | undefined;
let activeWorkerContext: ActiveWorkerContext | undefined;
let activeAttemptContext: ActiveAttemptContext | undefined;

function nonEmptyTrimmed(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function validatePositiveInt(
  value: number | undefined,
  name: string,
  allowZero = false,
): number | undefined {
  if (value === undefined) return undefined;
  const min = allowZero ? 0 : 1;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    throw new ConfigurationError(
      "INVALID_CONFIG",
      `softprobeWeb({ ${name} }) must be an integer >= ${min}, got ${String(value)}`,
    );
  }
  return value;
}

function validateStoreMode(mode: unknown): SoftprobeStoreMode | undefined {
  if (mode === undefined) return undefined;
  if (mode === "auto" || mode === "blackbox" || mode === "arex") {
    return mode;
  }
  throw new ConfigurationError(
    "INVALID_CONFIG",
    `softprobeWeb({ store }) must be "auto", "blackbox", or "arex", got ${JSON.stringify(mode)}`,
  );
}

function validateApiOrigins(
  apiOrigins: SoftprobeWebOptions["apiOrigins"],
): readonly (string | RegExp)[] | undefined {
  if (apiOrigins === undefined) return undefined;
  if (!Array.isArray(apiOrigins)) {
    throw new ConfigurationError(
      "INVALID_CONFIG",
      "softprobeWeb({ apiOrigins }) must be an array of URL strings, patterns, or RegExp instances",
    );
  }
  for (const [index, entry] of apiOrigins.entries()) {
    if (entry instanceof RegExp) continue;
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new ConfigurationError(
        "INVALID_CONFIG",
        `softprobeWeb({ apiOrigins })[${index}] must be a non-empty string or RegExp`,
      );
    }
  }
  return [...apiOrigins];
}

function validateExplicitSink(sink: SoftprobeSinkConfig | undefined): void {
  if (sink === undefined) return;
  if (typeof sink !== "object" || sink === null) {
    throw new ConfigurationError(
      "INVALID_CONFIG",
      "softprobeWeb({ sink }) must be a sink configuration object",
    );
  }
  if (sink.kind === "blackbox") {
    if (!nonEmptyTrimmed(sink.endpoint)) {
      throw new ConfigurationError(
        "INVALID_CONFIG",
        'softprobeWeb({ sink }) with kind "blackbox" requires a non-empty endpoint',
      );
    }
    return;
  }
  if (sink.kind === "arex") {
    if (!nonEmptyTrimmed(sink.endpoint)) {
      throw new ConfigurationError(
        "INVALID_CONFIG",
        'softprobeWeb({ sink }) with kind "arex" requires a non-empty endpoint',
      );
    }
    if (!nonEmptyTrimmed(sink.appId)) {
      throw new ConfigurationError(
        "INVALID_CONFIG",
        'softprobeWeb({ sink }) with kind "arex" requires a non-empty appId',
      );
    }
    return;
  }
  const _exhaustive: never = sink;
  throw new ConfigurationError(
    "INVALID_CONFIG",
    `Unsupported sink kind in softprobeWeb: ${JSON.stringify(_exhaustive)}`,
  );
}

export function splitSoftprobeWebOptions(options: SoftprobeWebOptions = {}): {
  readonly webOptions: WebOptions;
  readonly metadata: SoftprobeEngineMetadata;
} {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new ConfigurationError(
      "INVALID_CONFIG",
      "softprobeWeb(options) requires a plain options object",
    );
  }

  validateExplicitSink(options.sink);
  validateStoreMode(options.store);
  const apiOrigins = validateApiOrigins(options.apiOrigins);
  const pollTimeoutMs =
    validatePositiveInt(options.pollTimeoutMs, "pollTimeoutMs") ??
    validatePositiveInt(options.traceTimeoutMs, "traceTimeoutMs") ??
    DEFAULT_POLL_TIMEOUT_MS;
  const pollIntervalMs =
    validatePositiveInt(options.pollIntervalMs, "pollIntervalMs") ??
    DEFAULT_POLL_INTERVAL_MS;
  const settleMs =
    validatePositiveInt(options.settleMs, "settleMs", true) ?? DEFAULT_SETTLE_MS;

  const webEntries: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(options)) {
    if (!SOFTPROBE_OPTION_KEYS.has(key)) {
      webEntries.push([key, value]);
    }
  }

  const webOptions: WebOptions = Object.fromEntries(webEntries);
  const metadata: SoftprobeEngineMetadata = {
    rawOptions: options,
    apiOrigins,
    polling: {
      pollTimeoutMs,
      pollIntervalMs,
      settleMs,
    },
  };

  return { webOptions, metadata };
}

function normalizeEndpointUrl(rawEndpoint: string, kind: "blackbox" | "arex"): string {
  const trimmed = rawEndpoint.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ConfigurationError(
      "INVALID_CONFIG",
      `Invalid Softprobe ${kind} endpoint URL: ${JSON.stringify(rawEndpoint)}`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigurationError(
      "INVALID_CONFIG",
      `Softprobe ${kind} endpoint must use http: or https:, got ${parsed.protocol}`,
    );
  }
  if (
    kind === "blackbox" &&
    (parsed.pathname === "" || parsed.pathname === "/") &&
    /^explorer(?:-[a-z0-9-]+)?\.softprobe\.ai$/i.test(parsed.hostname)
  ) {
    return `${parsed.origin}/api/thelake`;
  }
  return trimmed;
}

function deriveExplorerBaseUrl(
  explicitExplorerUrl: string | undefined,
  sinkEndpoint: string,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const configured =
    nonEmptyTrimmed(explicitExplorerUrl) ??
    nonEmptyTrimmed(env.SOFTPROBE_EXPLORER_URL) ??
    nonEmptyTrimmed(env.SP_EXPLORER_URL);
  if (configured) {
    return configured.replace(/\/+$/, "");
  }
  if (sinkEndpoint.endsWith("/api/thelake")) {
    return sinkEndpoint.slice(0, -"/api/thelake".length);
  }
  return undefined;
}

export function resolveSinkConfig(
  options: SoftprobeWebOptions,
  env: Readonly<Record<string, string | undefined>> = process.env,
): SoftprobeSinkConfig {
  if (options.sink !== undefined) {
    if (options.sink.kind === "blackbox") {
      const endpoint = normalizeEndpointUrl(options.sink.endpoint, "blackbox");
      const token =
        nonEmptyTrimmed(options.sink.token) ??
        nonEmptyTrimmed(env.SOFTPROBE_API_KEY);
      const workspaceId =
        nonEmptyTrimmed(options.sink.workspaceId) ??
        nonEmptyTrimmed(env.SOFTPROBE_WORKSPACE_ID) ??
        nonEmptyTrimmed(env.SP_WORKSPACE_ID);
      const explorerUrl = deriveExplorerBaseUrl(options.sink.explorerUrl, endpoint, env);
      return {
        kind: "blackbox",
        endpoint,
        ...(token ? { token } : {}),
        ...(workspaceId ? { workspaceId } : {}),
        ...(explorerUrl ? { explorerUrl } : {}),
      };
    }
    if (options.sink.kind === "arex") {
      const endpoint = normalizeEndpointUrl(options.sink.endpoint, "arex");
      const token =
        nonEmptyTrimmed(options.sink.token) ??
        nonEmptyTrimmed(env.SOFTPROBE_API_KEY) ??
        nonEmptyTrimmed(env.SP_TOKEN);
      const tenantId =
        nonEmptyTrimmed(options.sink.tenantId) ??
        nonEmptyTrimmed(env.SP_TENANT_ID);
      const explorerUrl = deriveExplorerBaseUrl(options.sink.explorerUrl, endpoint, env);
      return {
        kind: "arex",
        endpoint,
        appId: options.sink.appId.trim(),
        ...(token ? { token } : {}),
        ...(tenantId ? { tenantId } : {}),
        ...(explorerUrl ? { explorerUrl } : {}),
      };
    }
    const _exhaustive: never = options.sink;
    return _exhaustive;
  }

  const envStoreRaw = nonEmptyTrimmed(env.SOFTPROBE_STORE_MODE);
  const store =
    validateStoreMode(options.store) ??
    (envStoreRaw ? validateStoreMode(envStoreRaw) : undefined) ??
    "auto";
  const appId =
    nonEmptyTrimmed(options.appId) ??
    nonEmptyTrimmed(env.SOFTPROBE_APP_ID) ??
    nonEmptyTrimmed(env.SP_APP_ID);
  const workspaceId =
    nonEmptyTrimmed(options.workspaceId) ??
    nonEmptyTrimmed(env.SOFTPROBE_WORKSPACE_ID) ??
    nonEmptyTrimmed(env.SP_WORKSPACE_ID);

  const effectiveKind: "blackbox" | "arex" =
    store === "arex"
      ? "arex"
      : store === "blackbox"
        ? "blackbox"
        : appId !== undefined && workspaceId === undefined
          ? "arex"
          : "blackbox";

  if (effectiveKind === "arex") {
    const rawEndpoint =
      nonEmptyTrimmed(options.endpoint) ??
      nonEmptyTrimmed(env.SOFTPROBE_SINK_ENDPOINT) ??
      nonEmptyTrimmed(env.SOFTPROBE_TRACE_ENDPOINT) ??
      nonEmptyTrimmed(env.SP_API_URL) ??
      nonEmptyTrimmed(env.SOFTPROBE_URL);
    if (!rawEndpoint) {
      throw new ConfigurationError(
        "INVALID_CONFIG",
        "Arex trace verification requires endpoint in softprobeWeb({ endpoint }) or SP_API_URL / SOFTPROBE_URL",
      );
    }
    if (!appId) {
      throw new ConfigurationError(
        "INVALID_CONFIG",
        "Arex trace verification requires appId in softprobeWeb({ appId }) or SOFTPROBE_APP_ID / SP_APP_ID",
      );
    }
    const endpoint = normalizeEndpointUrl(rawEndpoint, "arex");
    const token =
      nonEmptyTrimmed(options.token) ??
      nonEmptyTrimmed(env.SOFTPROBE_API_KEY) ??
      nonEmptyTrimmed(env.SP_TOKEN);
    const tenantId =
      nonEmptyTrimmed(options.tenantId) ?? nonEmptyTrimmed(env.SP_TENANT_ID);
    const explorerUrl = deriveExplorerBaseUrl(options.explorerUrl, endpoint, env);
    return {
      kind: "arex",
      endpoint,
      appId,
      ...(token ? { token } : {}),
      ...(tenantId ? { tenantId } : {}),
      ...(explorerUrl ? { explorerUrl } : {}),
    };
  }

  const rawEndpoint =
    nonEmptyTrimmed(options.endpoint) ??
    nonEmptyTrimmed(env.SOFTPROBE_SINK_ENDPOINT) ??
    nonEmptyTrimmed(env.SOFTPROBE_TRACE_ENDPOINT) ??
    nonEmptyTrimmed(env.SOFTPROBE_URL) ??
    nonEmptyTrimmed(env.SP_API_URL) ??
    nonEmptyTrimmed(env.SOFTPROBE_BASE_URL) ??
    nonEmptyTrimmed(env.THELAKE_URL) ??
    DEFAULT_BLACKBOX_ENDPOINT;
  const endpoint = normalizeEndpointUrl(rawEndpoint, "blackbox");
  const token =
    nonEmptyTrimmed(options.token) ??
    nonEmptyTrimmed(env.SOFTPROBE_API_KEY);
  const explorerUrl = deriveExplorerBaseUrl(options.explorerUrl, endpoint, env);

  return {
    kind: "blackbox",
    endpoint,
    ...(token ? { token } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(explorerUrl ? { explorerUrl } : {}),
  };
}

export function attachEngineMetadata(
  engineHandle: object,
  metadata: SoftprobeEngineMetadata,
): void {
  engineMetadataMap.set(engineHandle, metadata);
  latestRegisteredMetadata = metadata;
}

export function getEngineMetadata(
  engineHandle: object,
): SoftprobeEngineMetadata | undefined {
  return engineMetadataMap.get(engineHandle);
}

export function registerTargetMetadata(
  targetName: string,
  metadata: SoftprobeEngineMetadata,
): void {
  targetMetadataByName.set(targetName, metadata);
}

export function setActiveWorkerContext(context: ActiveWorkerContext): void {
  activeWorkerContext = context;
}

export function clearActiveWorkerContext(targetName?: string): void {
  if (
    targetName === undefined ||
    activeWorkerContext?.targetName === targetName
  ) {
    activeWorkerContext = undefined;
  }
}

export function getActiveWorkerContext(): ActiveWorkerContext | undefined {
  return activeWorkerContext;
}

export function setActiveAttemptContext(context: ActiveAttemptContext): void {
  activeAttemptContext = context;
}

export function clearActiveAttemptContext(attemptId?: string): void {
  if (
    attemptId === undefined ||
    activeAttemptContext?.attemptId === attemptId
  ) {
    activeAttemptContext = undefined;
  }
}

export function getActiveAttemptContext(): ActiveAttemptContext | undefined {
  return activeAttemptContext;
}

export function resolveCurrentAttemptMetadata(): {
  readonly metadata: SoftprobeEngineMetadata;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly targetName: string | undefined;
  readonly runId: string | undefined;
  readonly projectRoot: string | undefined;
  readonly attemptId: string | undefined;
  readonly artifactsDir: string | undefined;
} {
  if (activeWorkerContext !== undefined) {
    return {
      metadata: activeWorkerContext.metadata,
      env: activeWorkerContext.env,
      targetName: activeWorkerContext.targetName,
      runId: activeWorkerContext.runId,
      projectRoot: activeWorkerContext.projectRoot,
      attemptId: activeAttemptContext?.attemptId,
      artifactsDir: activeAttemptContext?.artifactsDir,
    };
  }

  const fallback =
    latestRegisteredMetadata ??
    targetMetadataByName.values().next().value ??
    splitSoftprobeWebOptions({}).metadata;

  return {
    metadata: fallback,
    env: process.env,
    targetName: undefined,
    runId: undefined,
    projectRoot: process.cwd(),
    attemptId: activeAttemptContext?.attemptId,
    artifactsDir: activeAttemptContext?.artifactsDir,
  };
}
