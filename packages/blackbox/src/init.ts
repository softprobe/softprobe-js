import path from "node:path";
import { bootstrapProject } from "./bootstrap.js";
import { writeEnvVar } from "./env.js";
import { authenticateWithExplorer, defaultOpenUrl } from "./oauth.js";
import { inferProjectName } from "./project.js";
import {
  INGESTION_KEY_ENV_VAR,
  type BootstrapProjectResult,
  type InitDeps,
  type InitOptions,
  type InitResult,
} from "./types.js";

const defaultDeps: InitDeps = {
  fetch: globalThis.fetch,
  openUrl: defaultOpenUrl,
  log: (message: string) => console.log(message),
};

export async function runInit(
  options: InitOptions,
  deps: Partial<InitDeps> = {},
): Promise<InitResult> {
  const resolvedDeps: InitDeps = {
    fetch: deps.fetch ?? defaultDeps.fetch,
    openUrl: deps.openUrl ?? defaultDeps.openUrl,
    log: deps.log ?? defaultDeps.log,
  };

  const projectName = options.projectName ?? (await inferProjectName(options.cwd));

  let ingestionKey = options.ingestionKey;
  let source: "flag" | "oauth" = "flag";
  let bootstrapped: BootstrapProjectResult | undefined;

  if (!ingestionKey) {
    source = "oauth";
    const accessToken = await authenticateWithExplorer({
      explorerUrl: options.explorerUrl,
      openBrowser: options.openBrowser,
      fetch: resolvedDeps.fetch,
      openUrl: resolvedDeps.openUrl,
      log: resolvedDeps.log,
    });
    bootstrapped = await bootstrapProject({
      explorerUrl: options.explorerUrl,
      accessToken,
      projectName,
      fetch: resolvedDeps.fetch,
    });
    ingestionKey = bootstrapped.ingestionKey;
  }

  const targetEnvPath = path.isAbsolute(options.envFile)
    ? options.envFile
    : path.join(options.cwd, options.envFile);

  const written = await writeEnvVar({
    envPath: targetEnvPath,
    key: INGESTION_KEY_ENV_VAR,
    value: ingestionKey,
  });

  return {
    projectName,
    explorerUrl: options.explorerUrl,
    envPath: written.envPath,
    ingestionKey,
    source,
    envAction: written.action,
    ...(bootstrapped
      ? {
          workspaceId: bootstrapped.workspaceId,
          agentId: bootstrapped.agentId,
          otlpEndpoint: bootstrapped.otlpEndpoint,
        }
      : {}),
  };
}
