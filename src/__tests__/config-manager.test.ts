/**
 * Task 6.1.1: ConfigManager reads YAML synchronously at boot and exposes .get().
 */

import path from 'path';
import { ConfigManager } from '../config/config-manager';

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'softprobe-config.yml');

describe('ConfigManager', () => {
  it('reads fixture config file and exposes .get()', () => {
    const manager = new ConfigManager(FIXTURE_PATH);
    const cfg = manager.get();

    expect(cfg).toBeDefined();
    expect(cfg.capture).toEqual({
      maxPayloadSize: 1048576,
    });
    expect(cfg.replay).toBeDefined();
    expect((cfg.replay as { ignoreUrls: string[] }).ignoreUrls).toEqual([
      'localhost:431[78]',
      '/v1/traces',
      'api\\.stripe\\.com',
    ]);
  });

  it('exposes cassettePath from YAML at get().cassettePath', () => {
    const manager = new ConfigManager(FIXTURE_PATH);
    const cfg = manager.get();
    expect(cfg.cassettePath).toBe('./softprobe-cassettes.ndjson');
  });

  it('compiles ignore patterns into RegExp[] (pattern api\\.stripe\\.com matches URL)', () => {
    const manager = new ConfigManager(FIXTURE_PATH);
    const regexes = manager.getIgnoreRegexes();
    const url = 'https://api.stripe.com/v1/charges';
    expect(regexes.some((re: RegExp) => re.test(url))).toBe(true);
  });

  it('shouldIgnore(url) returns true for ignored, false for others', () => {
    const manager = new ConfigManager(FIXTURE_PATH);
    expect(manager.shouldIgnore('https://api.stripe.com/v1/charges')).toBe(true);
    expect(manager.shouldIgnore('http://localhost:4317/v1/traces')).toBe(true);
    expect(manager.shouldIgnore('https://api.example.com/foo')).toBe(false);
    expect(manager.shouldIgnore(undefined)).toBe(false);
    expect(manager.shouldIgnore('')).toBe(false);
  });
});
