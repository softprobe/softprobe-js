import { spawnSync } from 'child_process';

export type CaptureOptions = {
  url: string;
  traceId: string;
  method?: string;
  data?: string;
  headers?: string[];
  output?: string;
};

/**
 * Executes curl with Softprobe capture headers for one request.
 */
export function runCapture(opts: CaptureOptions): number {
  const args: string[] = ['-sS'];

  if (opts.method) {
    args.push('-X', opts.method);
  }
  args.push('-H', 'x-softprobe-mode: CAPTURE');
  args.push('-H', `x-softprobe-trace-id: ${opts.traceId}`);

  for (const header of opts.headers ?? []) {
    args.push('-H', header);
  }

  if (opts.data !== undefined) {
    args.push('--data', opts.data);
  }
  if (opts.output) {
    args.push('-o', opts.output);
  }

  args.push(opts.url);

  const result = spawnSync('curl', args, {
    stdio: 'inherit',
    env: process.env,
  });

  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}
