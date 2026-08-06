// Where a film can be watched LEGALLY, per country.
//
// The private instance answers "can I watch this?" from its own library. The
// public demo has no library, so it answers the same question honestly: TMDB
// resells JustWatch's availability feed (subscription / free / rent / buy per
// region), which is the closest thing to an authoritative answer that has a free
// API. TMDB's terms require the JustWatch attribution the UI renders alongside.
//
// Cached in film_watch with a shorter TTL than the metadata cache, because
// licences move: a film on a service this month may be gone the next.
import { env } from '$env/dynamic/private';
import { getWatchCache, setWatchCache } from './db.js';

const IMG = 'https://image.tmdb.org/t/p/w92';
const TTL_MS = 7 * 24 * 3600 * 1000;

// The regions we keep. TMDB returns every country in one response, so this is
// purely about what we store: enough to cover the likely visitor without
// carrying 200 countries of dead weight in every cached row.
export const REGIONS = [
  { code: 'GB', name: 'United Kingdom' },
  { code: 'US', name: 'United States' },
  { code: 'IE', name: 'Ireland' },
  { code: 'CA', name: 'Canada' },
  { code: 'AU', name: 'Australia' },
  { code: 'NZ', name: 'New Zealand' },
  { code: 'DE', name: 'Germany' },
  { code: 'FR', name: 'France' },
  { code: 'NL', name: 'Netherlands' },
  { code: 'ES', name: 'Spain' },
  { code: 'IT', name: 'Italy' },
  { code: 'SE', name: 'Sweden' },
  { code: 'DK', name: 'Denmark' },
  { code: 'PL', name: 'Poland' },
  { code: 'BR', name: 'Brazil' },
  { code: 'MX', name: 'Mexico' },
  { code: 'JP', name: 'Japan' },
  { code: 'KR', name: 'South Korea' },
  { code: 'IN', name: 'India' }
];
const KEEP = new Set(REGIONS.map((r) => r.code));
export const DEFAULT_REGION = 'GB';

/** A visitor's region, from whichever edge fronted the request. */
export function regionFromHeaders(headers) {
  const raw = headers.get('x-vercel-ip-country') || headers.get('cf-ipcountry') || '';
  const code = raw.trim().toUpperCase();
  return KEEP.has(code) ? code : DEFAULT_REGION;
}

async function fetchJSON(url, ms = 8000) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'tspdt-cinema/1.0' } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; } finally { clearTimeout(to); }
}

// TMDB groups offers by monetisation type. Collapse them into the four a viewer
// actually distinguishes, keeping TMDB's display_priority order (roughly "how
// prominent is this service here"). ads/free both mean "no payment required",
// which is worth surfacing above a rental.
const BUCKETS = [['free', ['free', 'ads']], ['stream', ['flatrate']], ['rent', ['rent']], ['buy', ['buy']]];

function normaliseRegion(r) {
  const out = { link: r.link || null };
  for (const [name, keys] of BUCKETS) {
    const seen = new Set();
    const list = [];
    for (const k of keys) {
      for (const p of (r[k] || []).slice().sort((a, b) => (a.display_priority ?? 99) - (b.display_priority ?? 99))) {
        if (seen.has(p.provider_id)) continue;
        seen.add(p.provider_id);
        list.push({ name: p.provider_name, logo: p.logo_path ? IMG + p.logo_path : null });
      }
    }
    if (list.length) out[name] = list;
  }
  return out;
}

/**
 * Availability for one film across every cached region.
 * → { enabled, regions: { GB: { link, free?, stream?, rent?, buy? } }, fetched_at }
 * `enabled:false` means no TMDB key, so the UI can say that instead of
 * implying the film is unavailable everywhere.
 */
export async function getWhereToWatch(film) {
  const key = env.TSPDT_TMDB_KEY?.trim();
  if (!key) return { enabled: false, regions: {} };

  const cached = getWatchCache(film.id_tspdt);
  if (cached && Date.now() - Date.parse(cached.fetched_at + 'Z') < TTL_MS) {
    return { enabled: true, ...JSON.parse(cached.json) };
  }

  // The catalogue is keyed on IMDb ids; TMDB's providers endpoint needs a TMDB
  // id, which manual additions and enriched films already carry.
  let tmdbId = Number.isSafeInteger(film.tmdb_id) && film.tmdb_id > 0 ? film.tmdb_id : null;
  if (!tmdbId && film.imdb_id) {
    const find = await fetchJSON(
      `https://api.themoviedb.org/3/find/${film.imdb_id}?external_source=imdb_id&api_key=${key}`
    );
    tmdbId = find?.movie_results?.[0]?.id || null;
  }
  if (!tmdbId) {
    // Nothing to ask about — cache the empty answer so we don't retry per view.
    const empty = { regions: {} };
    setWatchCache(film.id_tspdt, empty);
    return { enabled: true, ...empty };
  }

  const d = await fetchJSON(`https://api.themoviedb.org/3/movie/${tmdbId}/watch/providers?api_key=${key}`);
  // A failed call falls back to whatever we had rather than caching a blank:
  // "not on any service" and "TMDB timed out" must not look the same.
  if (!d?.results) {
    if (cached) return { enabled: true, ...JSON.parse(cached.json) };
    return { enabled: true, regions: {}, stale: true };
  }

  const regions = {};
  for (const [code, r] of Object.entries(d.results)) {
    if (!KEEP.has(code)) continue;
    const n = normaliseRegion(r);
    if (n.free || n.stream || n.rent || n.buy) regions[code] = n;
  }
  const out = { regions };
  setWatchCache(film.id_tspdt, out);
  return { enabled: true, ...out };
}
