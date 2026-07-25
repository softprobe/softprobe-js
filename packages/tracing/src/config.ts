/** Resolved Softprobe client credentials and transport endpoints. */
export type ResolvedSoftprobeConfig = {
  publicKey: string;
  baseUrl: string;
  otlpEndpoint: string;
  environment?: string;
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

/** Default OTLP traces path when `otlpEndpoint` is omitted. */
export function deriveOtlpEndpoint(
  baseUrl: string,
  explicit?: string,
): string {
  if (explicit?.trim()) return explicit.trim();
  return `${baseUrl.replace(/\/$/, "")}/v1/traces`;
}

export type SoftprobeEnvSource = Record<string, string | undefined>;

/**
 * Read Softprobe config from environment variables.
 * Returns null when required keys are missing (partial env is ignored).
 */
export function resolveSoftprobeConfigFromEnv(
  env: SoftprobeEnvSource = process.env,
): ResolvedSoftprobeConfig | null {
  const publicKey = asNonEmptyString(env.SOFTPROBE_PUBLIC_KEY);
  const baseUrl = asNonEmptyString(env.SOFTPROBE_BASE_URL);
  if (!publicKey || !baseUrl) return null;

  return {
    publicKey,
    baseUrl,
    otlpEndpoint: deriveOtlpEndpoint(
      baseUrl,
      asNonEmptyString(env.SOFTPROBE_OTLP_ENDPOINT),
    ),
    environment: asNonEmptyString(env.SOFTPROBE_ENVIRONMENT),
    userId: asNonEmptyString(env.SOFTPROBE_USER_ID),
    serviceName: asNonEmptyString(env.SOFTPROBE_SERVICE_NAME),
  };
}

/** Parse and validate a Softprobe config object (JSON file, host plugin config, etc.). */
export function resolveSoftprobeConfigFromObject(
  raw: unknown,
): ResolvedSoftprobeConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new MissingSoftprobeCredentialsError("Invalid Softprobe config object");
  }
  const obj = raw as Record<string, unknown>;
  const publicKey = asNonEmptyString(obj.publicKey);
  const baseUrl = asNonEmptyString(obj.baseUrl);
  if (!publicKey || !baseUrl) {
    throw new MissingSoftprobeCredentialsError(
      "publicKey and baseUrl are required",
    );
  }
  return {
    publicKey,
    baseUrl,
    otlpEndpoint: deriveOtlpEndpoint(
      baseUrl,
      asNonEmptyString(obj.otlpEndpoint),
    ),
    environment: asNonEmptyString(obj.environment),
    userId: asNonEmptyString(obj.userId),
    serviceName: asNonEmptyString(obj.serviceName),
  };
}
