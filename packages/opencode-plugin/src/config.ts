import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
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
 * Env vars win when both `SOFTPROBE_PUBLIC_KEY` and `SOFTPROBE_BASE_URL` are set.
 */
export async function loadSoftprobeCredentials(
  configPath?: string,
): Promise<SoftprobePluginCredentials> {
  const envCreds = resolveSoftprobeConfigFromEnv();
  if (envCreds) return envCreds;

  const paths = configPath ? [configPath] : candidateConfigPaths();
  const tried: string[] = [];

  for (const path of paths) {
    tried.push(path);
    if (!(await fileExists(path))) continue;
    try {
      const text = await readFile(path, "utf8");
      return resolveSoftprobeConfigFromObject(JSON.parse(text));
    } catch (error) {
      if (error instanceof MissingSoftprobeCredentialsError) throw error;
      throw new MissingSoftprobeCredentialsError(
        `Invalid Softprobe credentials in ${path}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  throw new MissingSoftprobeCredentialsError(
    `Missing Softprobe credentials (set SOFTPROBE_PUBLIC_KEY + SOFTPROBE_BASE_URL or create one of: ${tried.join(", ")})`,
  );
}
