import type {
  OtlpExportOptions,
  ResourceAttributes,
} from "./types.js";

export const DEFAULT_THELAKE_BASE_URL = "https://explorer.softprobe.ai/api/thelake";

/** Resolved Softprobe client credentials and OTLP transport settings. */
export type ResolvedSoftprobeConfig = {
  ingestionKey: string;
  /** @deprecated Use `ingestionKey`. */
  publicKey: string;
  baseUrl: string;
  /** @deprecated Use `otlp.tracesEndpoint`. */
  otlpEndpoint: string;
  otlp: OtlpExportOptions;
  resourceAttributes?: ResourceAttributes;
  environment?: string;
  /** Optional default; prefer the app's thread/chat id at emit time. */
  sessionId?: string;
  userId?: string;
  serviceName?: string;
};

export class MissingSoftprobeCredentialsError extends Error {
  constructor(message = "Missing Softprobe credentials") {
    super(message);
    this.name = "MissingSoftprobeCredentialsError";
  }
}

export function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Default OTLP traces path when an exact `tracesEndpoint` is omitted. */
export function deriveOtlpEndpoint(
  baseUrl: string,
  explicit?: string,
): string {
  if (explicit?.trim()) return explicit.trim();
  return `${baseUrl.replace(/\/$/, "")}/v1/traces`;
}

export type SoftprobeEnvSource = Record<string, string | undefined>;

function parseKeyValueList(value: string | undefined): Record<string, string> {
  if (!value?.trim()) return {};
  const result: Record<string, string> = {};
  for (const pair of value.split(",")) {
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    if (!name) continue;
    result[name] = pair.slice(separator + 1).trim();
  }
  return result;
}

export function mergeOtlpHeaders(
  ...sources: Array<Record<string, string> | undefined>
): Record<string, string> {
  const byLowerName = new Map<string, { name: string; value: string }>();
  for (const source of sources) {
    for (const [name, value] of Object.entries(source ?? {})) {
      byLowerName.set(name.toLowerCase(), { name, value });
    }
  }
  return Object.fromEntries(
    [...byLowerName.values()].map(({ name, value }) => [name, value]),
  );
}

function getHeader(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const lowerName = name.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === lowerName);
  return entry?.[1];
}

function bearerToken(value: string | undefined): string | undefined {
  const match = value?.trim().match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
}

function parseResourceAttributes(value: string | undefined): ResourceAttributes {
  const parsed = parseKeyValueList(value);
  return parsed;
}

function resourceAttributesFromObject(value: unknown): ResourceAttributes | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result: ResourceAttributes = {};
  for (const [key, attribute] of Object.entries(value)) {
    if (
      typeof attribute === "string" ||
      typeof attribute === "number" ||
      typeof attribute === "boolean" ||
      (Array.isArray(attribute) && attribute.every((item) =>
        typeof item === "string" || typeof item === "number" || typeof item === "boolean",
      ))
    ) {
      result[key] = attribute as ResourceAttributes[string];
    }
  }
  return result;
}

function headersFromObject(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value)) {
    if (typeof headerValue === "string") result[name] = headerValue;
  }
  return result;
}

export function validateOtlpProtocol(value: unknown): "http/protobuf" {
  const protocol = asNonEmptyString(value)?.toLowerCase();
  if (!protocol || protocol === "http/protobuf") return "http/protobuf";
  throw new Error(
    `Unsupported OTLP protocol "${protocol}". The Softprobe exporter supports http/protobuf.`,
  );
}

function resolveEnvOtlp(env: SoftprobeEnvSource, baseUrl: string): OtlpExportOptions & {
  tracesEndpoint: string;
} {
  const tracesEndpoint = asNonEmptyString(
    env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
  );
  const endpoint = asNonEmptyString(env.OTEL_EXPORTER_OTLP_ENDPOINT);
  const legacyEndpoint = asNonEmptyString(env.SOFTPROBE_OTLP_ENDPOINT);
  const protocol = validateOtlpProtocol(
    asNonEmptyString(env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL) ??
      asNonEmptyString(env.OTEL_EXPORTER_OTLP_PROTOCOL),
  );
  const headers = mergeOtlpHeaders(
    parseKeyValueList(env.OTEL_EXPORTER_OTLP_HEADERS),
    parseKeyValueList(env.OTEL_EXPORTER_OTLP_TRACES_HEADERS),
  );
  return {
    ...(endpoint ? { endpoint } : {}),
    tracesEndpoint: tracesEndpoint ??
      (endpoint ? deriveOtlpEndpoint(endpoint) : undefined) ??
      legacyEndpoint ??
      deriveOtlpEndpoint(baseUrl),
    protocol,
    ...(Object.keys(headers).length ? { headers } : {}),
  };
}

/**
 * Read Softprobe config from environment variables.
 * Returns null when the Ingestion Key is missing.
 */
export function resolveSoftprobeConfigFromEnv(
  env: SoftprobeEnvSource = process.env,
): ResolvedSoftprobeConfig | null {
  const headers = mergeOtlpHeaders(
    parseKeyValueList(env.OTEL_EXPORTER_OTLP_HEADERS),
    parseKeyValueList(env.OTEL_EXPORTER_OTLP_TRACES_HEADERS),
  );
  const ingestionKey =
    bearerToken(getHeader(headers, "authorization")) ??
    asNonEmptyString(env.SOFTPROBE_PUBLIC_KEY);
  const baseUrl =
    asNonEmptyString(env.SOFTPROBE_BASE_URL) ?? DEFAULT_THELAKE_BASE_URL;
  if (!ingestionKey) return null;

  const resourceAttributes = parseResourceAttributes(env.OTEL_RESOURCE_ATTRIBUTES);
  const serviceName =
    asNonEmptyString(env.OTEL_SERVICE_NAME) ??
    asNonEmptyString(resourceAttributes["service.name"]) ??
    asNonEmptyString(env.SOFTPROBE_SERVICE_NAME) ??
    asNonEmptyString(env.SOFTPROBE_AGENT_NAME);
  if (serviceName) resourceAttributes["service.name"] = serviceName;
  const environment =
    asNonEmptyString(resourceAttributes["deployment.environment.name"]) ??
    asNonEmptyString(env.SOFTPROBE_ENVIRONMENT);
  const otlp = resolveEnvOtlp(env, baseUrl);

  return {
    ingestionKey,
    publicKey: ingestionKey,
    baseUrl,
    otlpEndpoint: otlp.tracesEndpoint,
    otlp,
    ...(Object.keys(resourceAttributes).length ? { resourceAttributes } : {}),
    environment,
    sessionId: asNonEmptyString(env.SOFTPROBE_SESSION_ID),
    userId: asNonEmptyString(env.SOFTPROBE_USER_ID),
    serviceName,
  };
}

/** Parse and validate a direct Softprobe config object (JSON, host plugin config, etc.). */
export function resolveSoftprobeConfigFromObject(
  raw: unknown,
): ResolvedSoftprobeConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new MissingSoftprobeCredentialsError("Invalid Softprobe config object");
  }
  const obj = raw as Record<string, unknown>;
  const ingestionKey = asNonEmptyString(
    obj.ingestionKey ?? obj.ingestion_key ?? obj.apiKey ?? obj.api_key ??
      obj.publicKey ?? obj.public_key,
  );
  const rawBaseUrl = obj.baseUrl ?? obj.base_url;
  const baseUrl = rawBaseUrl === undefined
    ? DEFAULT_THELAKE_BASE_URL
    : asNonEmptyString(rawBaseUrl);
  if (!ingestionKey) {
    throw new MissingSoftprobeCredentialsError(
      "ingestionKey is required",
    );
  }
  if (!baseUrl) {
    throw new MissingSoftprobeCredentialsError(
      "baseUrl must be non-empty when provided",
    );
  }

  const rawOtlp = obj.otlp && typeof obj.otlp === "object" && !Array.isArray(obj.otlp)
    ? obj.otlp as Record<string, unknown>
    : {};
  const endpoint = asNonEmptyString(rawOtlp.endpoint);
  const tracesEndpoint = asNonEmptyString(
    rawOtlp.tracesEndpoint ?? rawOtlp.traces_endpoint,
  );
  const legacyEndpoint = asNonEmptyString(obj.otlpEndpoint ?? obj.otlp_endpoint);
  const otlpEndpoint = tracesEndpoint ?? legacyEndpoint ??
    deriveOtlpEndpoint(endpoint ?? baseUrl);
  const protocol = validateOtlpProtocol(rawOtlp.protocol);
  const otlpHeaders = headersFromObject(rawOtlp.headers);
  const resourceAttributes = resourceAttributesFromObject(
    obj.resourceAttributes ?? obj.resource_attributes,
  );
  const serviceName =
    asNonEmptyString(obj.serviceName ?? obj.service_name) ??
    asNonEmptyString(resourceAttributes?.["service.name"]);
  const environment =
    asNonEmptyString(resourceAttributes?.["deployment.environment.name"]) ??
    asNonEmptyString(obj.environment);

  return {
    ingestionKey,
    publicKey: ingestionKey,
    baseUrl,
    otlpEndpoint,
    otlp: {
      ...(endpoint ? { endpoint } : {}),
      tracesEndpoint: otlpEndpoint,
      protocol,
      ...(otlpHeaders ? { headers: otlpHeaders } : {}),
    },
    ...(resourceAttributes ? { resourceAttributes } : {}),
    environment,
    sessionId: asNonEmptyString(obj.sessionId ?? obj.session_id),
    userId: asNonEmptyString(obj.userId ?? obj.user_id),
    serviceName,
  };
}
