/**
 * Config loader for .softprobe/config.yml.
 * Must be discoverable synchronously at boot (softprobe/init first).
 */

import fs from 'fs';
import { parse } from 'yaml';

const DEFAULT_CONFIG_PATH = './.softprobe/config.yml';

/**
 * Reads and caches .softprobe/config.yml. Exposes parsed config via get().
 * Accepts optional configPath for testing (fixture path).
 */
export class ConfigManager {
  private cfg: Record<string, unknown>;
  private ignoreRegexes: RegExp[] = [];

  constructor(configPath: string = DEFAULT_CONFIG_PATH) {
    const raw = fs.readFileSync(configPath, 'utf8');
    this.cfg = parse(raw) as Record<string, unknown>;
    const urls = (this.cfg.replay as { ignoreUrls?: string[] } | undefined)?.ignoreUrls ?? [];
    this.ignoreRegexes = urls.map((p: string) => new RegExp(p));
  }

  /** Returns the parsed config object. */
  get(): Record<string, unknown> {
    return this.cfg;
  }

  /** Returns compiled ignore-url patterns (for bypass checks). */
  getIgnoreRegexes(): RegExp[] {
    return this.ignoreRegexes;
  }

  /** Returns true if url matches any replay.ignoreUrls pattern; false if no url or no match. */
  shouldIgnore(url?: string): boolean {
    if (url == null || url === '') return false;
    return this.ignoreRegexes.some((re) => re.test(url));
  }
}
