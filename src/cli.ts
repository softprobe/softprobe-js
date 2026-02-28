#!/usr/bin/env node
/**
 * CLI entry point for softprobe. Usage: softprobe diff <cassette.ndjson> <targetUrl>
 * Task 21.3.1: on mismatch, prints colored diff of recorded vs live and exits 1.
 */

import { runDiff } from './cli/diff';
import { reportDiff } from './cli/diff-reporter';
import { runCapture } from './cli/capture';

const args = process.argv.slice(2);
const command = args[0];
const HELP_COMMANDS = new Set(['help', '--help', '-h']);
const VERSION_COMMANDS = new Set(['version', '--version', '-v']);
function usage(): void {
  console.error('Usage: softprobe diff [--ignore-paths <path> ...] <cassette.ndjson> <targetUrl>');
  console.error('       softprobe capture <url> --trace-id <traceId> [--method <METHOD>] [--data <body>] [--header <k:v> ...] [--output <file>]');
  console.error('       softprobe --help');
  console.error('       softprobe --version');
  console.error('  Replays the recorded inbound request to the target with coordination headers.');
  console.error('  capture: invokes curl with Softprobe capture headers for one request.');
  console.error('  --ignore-paths  JSON path to omit from body comparison (e.g. http.headers for upstream variance).');
}

function printVersion(): void {
  // Read version from package metadata at runtime for both dist and ts-node execution.
  // dist/cli.js -> ../package.json, src/cli.ts -> ../package.json
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pkg = require('../package.json') as { version?: string };
  process.stdout.write(`softprobe ${pkg.version ?? '0.0.0'}\n`);
}

/** Extracts recorded status and body from cassette inbound (responsePayload or top-level). */
function getRecordedResponse(inbound: { responsePayload?: unknown; statusCode?: number }): {
  statusCode?: number;
  body?: unknown;
} {
  const payload = inbound.responsePayload as { statusCode?: number; status?: number; body?: unknown } | undefined;
  return {
    statusCode: payload?.statusCode ?? payload?.status ?? inbound.statusCode,
    body: payload?.body,
  };
}

async function main(): Promise<number> {
  if (!command || HELP_COMMANDS.has(command)) {
    usage();
    return command ? 0 : 1;
  }
  if (VERSION_COMMANDS.has(command)) {
    printVersion();
    return 0;
  }
  if (command === 'capture') {
    const captureArgs = args.slice(1);
    const captureUrl = captureArgs[0];
    if (!captureUrl) {
      usage();
      return 1;
    }
    let traceId = '';
    let method = 'GET';
    let data: string | undefined;
    const headers: string[] = [];
    let output: string | undefined;
    for (let i = 1; i < captureArgs.length; i++) {
      const token = captureArgs[i]!;
      if (token === '--trace-id' && captureArgs[i + 1]) {
        traceId = captureArgs[++i]!;
      } else if (token === '--method' && captureArgs[i + 1]) {
        method = captureArgs[++i]!;
      } else if (token === '--data' && captureArgs[i + 1]) {
        data = captureArgs[++i]!;
      } else if (token === '--header' && captureArgs[i + 1]) {
        headers.push(captureArgs[++i]!);
      } else if (token === '--output' && captureArgs[i + 1]) {
        output = captureArgs[++i]!;
      } else {
        console.error(`Unknown or incomplete capture option: ${token}`);
        return 1;
      }
    }
    if (!traceId) {
      console.error('capture requires --trace-id <traceId>');
      return 1;
    }
    return runCapture({ url: captureUrl, traceId, method, data, headers, output });
  }

  const ignoreBodyPaths: string[] = [];
  const positional: string[] = [];
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--ignore-paths' && args[i + 1]) {
      ignoreBodyPaths.push(args[++i]!);
    } else {
      positional.push(args[i]!);
    }
  }
  const file = positional[0];
  const target = positional[1];

  if (command !== 'diff' || !file || !target) {
    usage();
    return 1;
  }
  try {
    const { response, inbound } = await runDiff(file, target);
    const liveBody = await response.text();
    const recorded = getRecordedResponse(inbound);
    const match = reportDiff(
      recorded,
      { status: response.status, body: liveBody },
      { ignoreBodyPaths: ignoreBodyPaths.length ? ignoreBodyPaths : undefined }
    );
    if (!match) return 1;
    process.stderr.write('softprobe diff: PASS (response matches recording)\n');
    if (liveBody) process.stdout.write(liveBody + (liveBody.endsWith('\n') ? '' : '\n'));
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
