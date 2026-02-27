import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Tracks temporary test files and removes them during test teardown.
 * Keeps E2E setup/cleanup consistent across suites.
 */
export class E2eArtifacts {
  private readonly files = new Set<string>();
  private readonly dirs = new Set<string>();

  registerFile(filePath: string): string {
    this.files.add(filePath);
    this.removeIfExists(filePath);
    return filePath;
  }

  createTempFile(prefix: string, extension: string): string {
    const filePath = path.join(
      os.tmpdir(),
      `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}${extension}`
    );
    return this.registerFile(filePath);
  }

  createTempDir(prefix: string): string {
    const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
    this.dirs.add(dirPath);
    return dirPath;
  }

  createSoftprobeConfig(
    prefix: string,
    config: {
      mode: 'CAPTURE' | 'REPLAY' | 'PASSTHROUGH';
      cassetteDirectory: string;
      traceId?: string;
      strictReplay?: boolean;
      strictComparison?: boolean;
    }
  ): string {
    const configPath = this.createTempFile(prefix, '.yml');
    const lines = [
      `mode: ${config.mode}`,
      `cassetteDirectory: ${JSON.stringify(config.cassetteDirectory)}`,
      ...(config.traceId ? [`traceId: ${JSON.stringify(config.traceId)}`] : []),
      'replay:',
      `  strictReplay: ${config.strictReplay ? 'true' : 'false'}`,
      `  strictComparison: ${config.strictComparison ? 'true' : 'false'}`,
    ];
    fs.writeFileSync(configPath, `${lines.join('\n')}\n`, 'utf8');
    return configPath;
  }

  removeIfExists(filePath: string): void {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }

  cleanup(): void {
    for (const filePath of this.files) {
      this.removeIfExists(filePath);
    }
    this.files.clear();
    for (const dirPath of this.dirs) {
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
    this.dirs.clear();
  }
}
