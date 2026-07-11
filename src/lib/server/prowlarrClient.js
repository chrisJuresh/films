// Prowlarr search client. Used as a fallback when Radarr's own interactive
// search returns nothing — typically because Radarr searches indexers on the
// movie's TMDB year, which can differ from the year a release is tagged with
// (Radarr owns that year and won't let us override it). Prowlarr lets us run a
// plain text search with OUR catalogue year, then we hand the chosen release
// back to Radarr via release/push so it still imports/renames normally.

export class ProwlarrError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'ProwlarrError';
    this.status = status;
  }
}

const QUALITY_RE = /\b(2160p|1080p|720p|480p)\b/i;

function mapRelease(r) {
  return {
    source: 'prowlarr',
    guid: r.guid,
    indexerId: r.indexerId ?? null,
    indexer: r.indexer || null,
    protocol: r.protocol || null,                    // 'torrent' | 'usenet'
    title: r.title,
    quality: (r.title || '').match(QUALITY_RE)?.[1]?.toLowerCase() || null,
    size: Number(r.size) || null,
    seeders: r.seeders ?? null,
    languages: [],                                   // Prowlarr doesn't parse these
    score: 0,
    rejected: false,
    rejections: [],
    // Fields Radarr's release/push needs to grab it:
    downloadUrl: r.downloadUrl || null,
    magnetUrl: r.magnetUrl || null,
    publishDate: r.publishDate || null
  };
}

/**
 * Search Prowlarr across all movie-category indexers for `${query} ${year}`.
 * Returns up to 50 candidate releases, torrents sorted by seeders. Never throws
 * for an empty result — only for auth/transport failures.
 */
export async function prowlarrSearch(settings, query, year, fetchImpl = globalThis.fetch) {
  const term = [query, year].filter(Boolean).join(' ').trim();
  if (!term) return [];

  const url = new URL('api/v1/search', settings.baseUrl);
  url.searchParams.set('query', term);
  url.searchParams.set('type', 'search');
  url.searchParams.set('limit', '100');
  url.searchParams.append('categories', '2000');     // 2000 = Movies

  let res;
  try {
    res = await fetchImpl(url, { headers: { 'X-Api-Key': settings.apiKey } });
  } catch {
    throw new ProwlarrError('Could not reach Prowlarr.', 502);
  }
  if (res.status === 401 || res.status === 403) {
    throw new ProwlarrError('Prowlarr rejected the configured API key.', 502);
  }
  if (!res.ok) throw new ProwlarrError('Prowlarr search failed.', 502);

  let body;
  try { body = await res.json(); } catch { throw new ProwlarrError('Prowlarr returned an invalid response.', 502); }
  const list = Array.isArray(body) ? body : [];
  return list
    .map(mapRelease)
    .sort((a, b) => (b.seeders || 0) - (a.seeders || 0))
    .slice(0, 50);
}
