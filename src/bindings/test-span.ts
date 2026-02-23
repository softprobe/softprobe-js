/**
 * Shared test helper for binding tests (Task 3.1.1).
 * Returns a mock span with setAttribute(k,v) and an attributes bag so that
 * PostgresSpan, RedisSpan, and HttpSpan tests can assert tagged values without OTel.
 */

export type TestSpan = {
  setAttribute(key: string, value: unknown): void;
  attributes: Record<string, unknown>;
};

/**
 * Creates a mock span for use in binding tests. Calling setAttribute(k, v)
 * stores the value in the span's attributes bag.
 */
export function testSpan(): TestSpan {
  const attributes: Record<string, unknown> = {};
  return {
    setAttribute(key: string, value: unknown) {
      attributes[key] = value;
    },
    get attributes() {
      return attributes;
    },
  };
}
