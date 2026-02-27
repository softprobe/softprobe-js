/**
 * Typed binding for HTTP spans (design §7.2).
 * tagRequest sets protocol, identifier (via httpIdentifier), and optional request body.
 */

import { httpIdentifier } from '../identifier';

/** Span-like with setAttribute (OTel Span or test span). */
type SpanLike = { setAttribute?(key: string, value: unknown): void } | undefined;

/** Span-like with readable attributes. */
type ReadableSpan = { attributes?: Record<string, unknown> } | undefined;

/** Data extracted from an http-tagged span by fromSpan. */
export type HttpSpanData = {
  protocol: 'http';
  identifier: string;
};

/**
 * Tags the span with http protocol and identifier from method + url.
 * Optionally stores a small request body (e.g. bodyText) when provided.
 *
 * @param method - HTTP method (e.g. 'GET', 'POST').
 * @param url - Request URL.
 * @param bodyText - Optional request body string (stored as-is when provided).
 * @param span - Target span; pass test span in tests.
 */
export function tagRequest(
  method: string,
  url: string,
  bodyText?: string,
  span?: SpanLike
): void {
  if (!span?.setAttribute) return;
  span.setAttribute('softprobe.protocol', 'http');
  span.setAttribute('softprobe.identifier', httpIdentifier(method, url));
  if (bodyText !== undefined) {
    span.setAttribute('softprobe.request.body', bodyText);
  }
}

/**
 * Reads protocol and identifier from a span. Returns http data when the span
 * is tagged with softprobe.protocol === 'http'; otherwise null.
 */
export function fromSpan(span: ReadableSpan): HttpSpanData | null {
  const protocol = span?.attributes?.['softprobe.protocol'];
  if (protocol === 'http') {
    const identifier = span?.attributes?.['softprobe.identifier'];
    if (typeof identifier === 'string') return { protocol: 'http', identifier };
  }

  // OTel HTTP client span fallback (no softprobe tagging required).
  const attrs = span?.attributes ?? {};
  const methodRaw =
    attrs['http.request.method'] ??
    attrs['http.method'] ??
    attrs['http.request.method_original'];
  const urlRaw =
    attrs['url.full'] ??
    attrs['http.url'] ??
    attrs['http.target'];
  if (typeof methodRaw === 'string' && typeof urlRaw === 'string') {
    return { protocol: 'http', identifier: httpIdentifier(methodRaw, urlRaw) };
  }
  return null;
}

/** HttpSpan namespace for tagRequest and fromSpan. */
export const HttpSpan = { tagRequest, fromSpan };
