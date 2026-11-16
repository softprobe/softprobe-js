import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  mergeOtlpHeaders,
  MissingSoftprobeCredentialsError,
  resolveSoftprobeConfigFromEnv,
  resolveSoftprobeConfigFromObject,
  type ResolvedSoftprobeConfig,
} from "@softprobe/tracing";

export type SoftprobePluginCredentials = ResolvedSoftprobeConfig;

export { MissingSoftprobeCredentialsError };

/**
 * OpenCode / spcode global config directory (XDG Base Directory).
 * Matches OpenCode: `$OPENCODE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/<app>`,
 * else `~/.config/<app>`. Softprobe spcode uses `spcode`; upstream OpenCode
 * uses `opencode`.
 * @see https://opencode.ai/docs/config/
 */
export function defaultConfigDir(app = "opencode"): string {
  const custom = process.env.OPENCODE_CONFIG_DIR?.trim();
  if (custom) return custom;

  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  const configHome = xdg || join(homedir(), ".config");
  return join(configHome, app);
}

export function defaultConfigPath(): string {
  return join(defaultConfigDir("opencode"), "opencode-softprobe.json");
}

/** Credential file candidates: env dir, then spcode, then opencode. */
export function candidateConfigPaths(): string[] {
  const custom = process.env.OPENCODE_CONFIG_DIR?.trim();
  if (custom) return [join(custom, "opencode-softprobe.json")];

  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  const configHome = xdg || join(homedir(), ".config");
  return [
    join(configHome, "spcode", "opencode-softprobe.json"),
    join(configHome, "opencode", "opencode-softprobe.json"),
  ];
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve Softprobe credentials for the OpenCode plugin.
 * Standard OTLP environment values fill omitted fields in the credential file.
 */
export async function loadSoftprobeCredentials(
  configPath?: string,
): Promise<SoftprobePluginCredentials> {
  const env = { ...process.env };
  const envCreds = resolveSoftprobeConfigFromEnv(env);

  const paths = configPath ? [configPath] : candidateConfigPaths();
  const tried: string[] = [];

  for (const path of paths) {
    tried.push(path);
    if (!(await fileExists(path))) continue;
    try {
      const text = await readFile(path, "utf8");
      const raw = JSON.parse(text);
      const fileCreds = resolveSoftprobeConfigFromObject(raw);
      const rawObject = raw as Record<string, unknown>;
      const rawOtlp = rawObject.otlp && typeof rawObject.otlp === "object"
        ? rawObject.otlp as Record<string, unknown>
        : {};
      const fileHasEndpoint = Boolean(
        rawOtlp.tracesEndpoint ?? rawOtlp.traces_endpoint ??
        rawOtlp.endpoint ?? rawObject.otlpEndpoint ?? rawObject.otlp_endpoint,
      );
      const envForFile = {
        ...process.env,
        SOFTPROBE_BASE_URL: fileCreds.baseUrl,
        INGESTION_KEY: fileCreds.ingestionKey,
      };
      const envDefaults = resolveSoftprobeConfigFromEnv(envForFile);
      if (!envDefaults) return fileCreds;

      const otlp = {
        ...envDefaults.otlp,
        ...fileCreds.otlp,
        tracesEndpoint: fileHasEndpoint
          ? fileCreds.otlp.tracesEndpoint
          : envDefaults.otlp.tracesEndpoint,
        protocol: rawOtlp.protocol
          ? fileCreds.otlp.protocol
          : envDefaults.otlp.protocol,
        headers: mergeOtlpHeaders(
          envDefaults.otlp.headers,
          fileCreds.otlp.headers,
        ),
      };
      const resourceAttributes = {
        ...(envDefaults.resourceAttributes ?? {}),
        ...(fileCreds.resourceAttributes ?? {}),
      };
      const hasFileEnvironment =
        rawObject.environment !== undefined ||
        Object.prototype.hasOwnProperty.call(
          fileCreds.resourceAttributes ?? {},
          "deployment.environment.name",
        );
      const hasFileServiceName =
        rawObject.serviceName !== undefined ||
        rawObject.service_name !== undefined ||
        Object.prototype.hasOwnProperty.call(
          fileCreds.resourceAttributes ?? {},
          "service.name",
        );
      const hasFileSessionId =
        rawObject.sessionId !== undefined || rawObject.session_id !== undefined;
      const hasFileUserId =
        rawObject.userId !== undefined || rawObject.user_id !== undefined;

      return {
        ...envDefaults,
        ...fileCreds,
        ingestionKey: fileCreds.ingestionKey,
        baseUrl: fileCreds.baseUrl,
        otlpEndpoint: fileHasEndpoint
          ? fileCreds.otlpEndpoint
          : envDefaults.otlpEndpoint,
        otlp,
        resourceAttributes,
        environment: hasFileEnvironment
          ? fileCreds.environment
          : envDefaults.environment,
        serviceName: hasFileServiceName
          ? fileCreds.serviceName
          : envDefaults.serviceName,
        sessionId: hasFileSessionId
          ? fileCreds.sessionId
          : envDefaults.sessionId,
        userId: hasFileUserId ? fileCreds.userId : envDefaults.userId,
      };
    } catch (error) {
      if (error instanceof MissingSoftprobeCredentialsError) throw error;
      throw new MissingSoftprobeCredentialsError(
        `Invalid Softprobe credentials in ${path}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  if (envCreds) return envCreds;

  throw new MissingSoftprobeCredentialsError(
    `Missing Softprobe credentials (set OTEL_EXPORTER_OTLP_HEADERS or OTEL_EXPORTER_OTLP_TRACES_HEADERS with the Ingestion Key, or create one of: ${tried.join(", ")})`,
  );
}
