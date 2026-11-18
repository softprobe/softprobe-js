import {
  DEFAULT_EXPLORER_URL,
  type CliCommand,
  type ExplorerUrl,
  type IngestionKey,
  type ProjectName,
} from "./types.js";

export function parseExplorerUrl(raw: string): ExplorerUrl | null {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.origin as ExplorerUrl;
  } catch {
    return null;
  }
}

export function parseNonEmptyIngestionKey(raw: string): IngestionKey | null {
  const trimmed = raw.trim();
  return trimmed.length > 0 ? (trimmed as IngestionKey) : null;
}

export function parseNonEmptyProjectName(raw: string): ProjectName | null {
  const trimmed = raw.trim();
  return trimmed.length > 0 ? (trimmed as ProjectName) : null;
}

function readFlagValue(
  argv: readonly string[],
  index: number,
  flag: string,
): { readonly value: string; readonly nextIndex: number } | { readonly error: string } {
  const current = argv[index] ?? "";
  const eqPrefix = `${flag}=`;
  if (current.startsWith(eqPrefix)) {
    return { value: current.slice(eqPrefix.length), nextIndex: index };
  }
  const next = argv[index + 1];
  if (next === undefined || next.startsWith("-")) {
    return { error: `Missing value for ${flag}` };
  }
  return { value: next, nextIndex: index + 1 };
}

export function formatHelpText(): string {
  return [
    "Usage: blackbox init [options]",
    "",
    "Initialize Softprobe Blackbox telemetry in the current project.",
    "",
    "Options:",
    `  --explorer-url <url>    Explorer base URL (default: ${DEFAULT_EXPLORER_URL})`,
    "  --ingestion-key <key>   Use an existing ingestion key (skips OAuth login)",
    "  --project <name>        Override inferred project name",
    "  --env-file <path>       Target env file (default: .env)",
    "  --no-open               Print login URL instead of opening a browser",
    "  -h, --help              Show this help message",
  ].join("\n");
}

/**
 * Parse CLI arguments into a validated command at the process boundary.
 */
export function parseCliArgs(
  argv: readonly string[],
  cwd: string = process.cwd(),
): CliCommand {
  if (argv.length === 0) {
    return { kind: "help" };
  }

  let command: string | undefined;
  let explorerUrlRaw = DEFAULT_EXPLORER_URL;
  let ingestionKeyRaw: string | undefined;
  let projectRaw: string | undefined;
  let envFile = ".env";
  let openBrowser = true;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") {
      return { kind: "help" };
    }
    if (arg === "--no-open") {
      openBrowser = false;
      continue;
    }
    if (arg === "--explorer-url" || arg.startsWith("--explorer-url=")) {
      const res = readFlagValue(argv, i, "--explorer-url");
      if ("error" in res) return { kind: "error", message: res.error };
      explorerUrlRaw = res.value;
      i = res.nextIndex;
      continue;
    }
    if (arg === "--ingestion-key" || arg.startsWith("--ingestion-key=")) {
      const res = readFlagValue(argv, i, "--ingestion-key");
      if ("error" in res) return { kind: "error", message: res.error };
      ingestionKeyRaw = res.value;
      i = res.nextIndex;
      continue;
    }
    if (
      arg === "--project" ||
      arg.startsWith("--project=") ||
      arg === "--name" ||
      arg.startsWith("--name=")
    ) {
      const flag = arg.startsWith("--name") ? "--name" : "--project";
      const res = readFlagValue(argv, i, flag);
      if ("error" in res) return { kind: "error", message: res.error };
      projectRaw = res.value;
      i = res.nextIndex;
      continue;
    }
    if (arg === "--env-file" || arg.startsWith("--env-file=")) {
      const res = readFlagValue(argv, i, "--env-file");
      if ("error" in res) return { kind: "error", message: res.error };
      if (!res.value.trim()) {
        return { kind: "error", message: "--env-file must not be empty" };
      }
      envFile = res.value.trim();
      i = res.nextIndex;
      continue;
    }
    if (arg.startsWith("-")) {
      return { kind: "error", message: `Unknown option: ${arg}` };
    }
    if (!command) {
      command = arg;
      continue;
    }
    return { kind: "error", message: `Unexpected argument: ${arg}` };
  }

  if (command !== "init") {
    return {
      kind: "error",
      message: command ? `Unknown command: ${command}. Run 'blackbox --help'.` : "Missing command. Run 'blackbox init'.",
    };
  }

  const explorerUrl = parseExplorerUrl(explorerUrlRaw);
  if (!explorerUrl) {
    return { kind: "error", message: `Invalid --explorer-url: ${explorerUrlRaw}` };
  }

  let ingestionKey: IngestionKey | undefined;
  if (ingestionKeyRaw !== undefined) {
    const parsed = parseNonEmptyIngestionKey(ingestionKeyRaw);
    if (!parsed) {
      return { kind: "error", message: "--ingestion-key must not be empty" };
    }
    ingestionKey = parsed;
  }

  let projectName: ProjectName | undefined;
  if (projectRaw !== undefined) {
    const parsed = parseNonEmptyProjectName(projectRaw);
    if (!parsed) {
      return { kind: "error", message: "--project must not be empty" };
    }
    projectName = parsed;
  }

  return {
    kind: "init",
    options: {
      cwd,
      explorerUrl,
      ...(ingestionKey ? { ingestionKey } : {}),
      ...(projectName ? { projectName } : {}),
      envFile,
      openBrowser,
    },
  };
}
