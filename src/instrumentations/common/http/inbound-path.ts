/**
 * Shared inbound request path resolver for HTTP framework adapters.
 * Normalizes to path-only form so capture/replay identifiers stay deterministic.
 */
export type InboundPathSource = {
  originalUrl?: string;
  url?: string;
  path?: string;
};

/**
 * Resolve canonical inbound path from framework request objects.
 * Priority is originalUrl -> url -> path. Preserves query string, drops fragments,
 * normalizes absolute URLs to path+query, and guarantees a rooted path.
 */
export function resolveInboundPath(source: InboundPathSource): string {
  const preferred = source.originalUrl ?? source.url ?? source.path ?? '/';
  const trimmed = preferred.trim();
  if (!trimmed) return '/';

  // Normalize absolute URL inputs to path+query only.
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      const normalized = `${parsed.pathname || '/'}${parsed.search}`;
      return normalized || '/';
    } catch {
      // Fall through to plain-path normalization.
    }
  }

  const withoutFragment = trimmed.split('#')[0] || '';
  const rooted =
    withoutFragment.startsWith('/')
      ? withoutFragment
      : withoutFragment.startsWith('?')
        ? `/${withoutFragment}`
        : `/${withoutFragment}`;
  return rooted || '/';
}
