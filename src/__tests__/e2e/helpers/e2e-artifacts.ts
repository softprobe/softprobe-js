import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Tracks temporary test files and removes them during test teardown.
 * Keeps E2E setup/cleanup consistent across suites.
 */
export class E2eArtifacts {
  private readonly files = new Set<string>();

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

  removeIfExists(filePath: string): void {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }

  cleanup(): void {
    for (const filePath of this.files) {
      this.removeIfExists(filePath);
    }
    this.files.clear();
  }
}
