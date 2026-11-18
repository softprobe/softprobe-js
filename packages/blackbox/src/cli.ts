#!/usr/bin/env node
import { formatHelpText, parseCliArgs } from "./args.js";
import { runInit } from "./init.js";
import { INGESTION_KEY_ENV_VAR } from "./types.js";

async function main(): Promise<void> {
  const command = parseCliArgs(process.argv.slice(2), process.cwd());

  if (command.kind === "help") {
    console.log(formatHelpText());
    return;
  }

  if (command.kind === "error") {
    console.error(`Error: ${command.message}`);
    process.exitCode = 1;
    return;
  }

  try {
    const result = await runInit(command.options);
    console.log(
      `Configured ${INGESTION_KEY_ENV_VAR} for "${result.projectName}" in ${result.envPath} (${result.envAction}).`,
    );
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

void main();
