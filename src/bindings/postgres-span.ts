/**
 * Typed binding for Postgres spans (design §7.2).
 * Encapsulates attribute keys; tagQuery sets protocol and identifier for matching.
 */

import { pgIdentifier } from '../identifier';

/** Span-like type with setAttribute (OTel Span or test span). */
type SpanLike = { setAttribute?(key: string, value: unknown): void } | undefined;

/** Span-like with readable attributes (OTel Span or test span). */
type ReadableSpan = { attributes?: Record<string, unknown> } | undefined;

/** Data extracted from a postgres-tagged span by fromSpan. */
export type PostgresSpanData = {
  protocol: 'postgres';
  identifier: string;
  sql: string;
  values: unknown[];
};

/**
 * Tags the given span with postgres protocol and identifier from the SQL text.
 * Identifier is built via pgIdentifier(sql) for capture/replay consistency.
 *
 * @param sql - Query text (used as identifier; normalization deferred).
 * @param values - Optional query parameters (reserved for fromSpan in 3.2.2).
 * @param span - Target span; when omitted, caller must pass active span for production use.
 */
export function tagQuery(
  sql: string,
  values?: unknown[],
  span?: SpanLike
): void {
  if (!span?.setAttribute) return;
  span.setAttribute('softprobe.protocol', 'postgres');
  span.setAttribute('softprobe.identifier', pgIdentifier(sql));
}

/**
 * Reads protocol and identifier from a span. Returns postgres data when the span
 * is tagged with softprobe.protocol === 'postgres', otherwise null.
 * sql is taken from identifier (pgIdentifier is pass-through); values from optional request body or [].
 */
export function fromSpan(span: ReadableSpan): PostgresSpanData | null {
  const protocol = span?.attributes?.['softprobe.protocol'];
  if (protocol !== 'postgres') return null;
  const identifier = span?.attributes?.['softprobe.identifier'];
  if (typeof identifier !== 'string') return null;
  return {
    protocol: 'postgres',
    identifier,
    sql: identifier,
    values: [],
  };
}

/** PostgresSpan namespace for tagQuery and fromSpan. */
export const PostgresSpan = { tagQuery, fromSpan };
