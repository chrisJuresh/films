// Server-only: look up whether a film is freely + legally available on the
// Internet Archive. We ONLY ever surface IA-hosted items (which IA publishes as
// freely watchable/downloadable), so a mismatch at worst links the wrong FREE
// film -- never copyrighted content. Results are cached in ia_cache.
import { getCachedAvailability, cacheAvailability } from './db.js';

const NEG_TTL_MS = 7 * 24 * 3600 * 1000;    // re-check "unavailable" after a week
const POS_TTL_MS = 30 * 24 * 3600 * 1000;   // re-validate "available" monthly (takedowns, rule changes)
// A real open/public-domain license, not merely any uploader-supplied URL.
const isOpenLicense = (u) => typeof u === 'string' && /creativecommons\.org\/(licenses|publicdomain)/i.test(u);
const VIDEO_RE = /\.(mp4|m4v|ogv|ogg|webm|mpeg|mpg|mkv|avi)$/i;
// Only trust items that live in film-oriented, freely-licensed collections. This
// fails CLOSED: unauthorised uploads of copyrighted films (which land in generic
// buckets, or lack an open license) are rejected rather than surfaced.
const ALLOW_COLL = new Set(['opensource_movies', 'feature_films', 'silent_films', 'silentfilms',
  'classic_movies', 'classic_tv_commercials', 'film_noir', 'moviesandfilms', 'publicmovies',
  'publicmoviesarchive', 'prelinger', 'silenthollywood']);
const DENY_COLL = new Set(['podcasts-video', 'community_media', 'newsandpublicaffairs', 'gamevideos',
  'social-media-video', 'additional_collections_video', 'archiveteam', 'archiveteam_videobot', 'web',
  'mirrortube', 'youtube', 'twitter-social-media-video', 'tvnews', 'tvarchive', 'vlogs', 'bliptv',
  'stream_only', 'sputnik', 'television']);
const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'le', 'la', 'les', 'de', 'et',
  'il', 'lo', 'los', 'las', 'der', 'die', 'das', 'und', 'el', 'un', 'une']);
// Words that mark an upload as NOT the film itself (reviews, reactions, extras).
const BLOCK = new Set(['review', 'reviews', 'reaction', 'reacts', 'reacting', 'trailer',
  'trailers', 'teaser', 'commentary', 'interview', 'documentary', 'analysis', 'essay',
  'breakdown', 'explained', 'recap', 'podcast', 'tribute', 'parody', 'remix', 'soundtrack',
  'ost', 'karaoke', 'trump', 'promo', 'sample', 'bloopers', 'blooper', 'reviewed', 'discussion',
  'riff', 'riffing', 'riffed', 'rifftrax', 'mst3k', 'watchalong', 'livestream', 'reupload',
  'fanedit', 'lecture', 'presents', 'presentation', 'compilation']);
// Format/quality noise stripped only when validating very short titles.
const FORMAT = new Set(['full', 'movie', 'film', 'hd', 'sd', '720p', '1080p', '480p', '4k',
  'x', 'mp', 'mp4', 'converted', 'dvd', 'vhs', 'rip', 'xvid', 'divx', 'avi', 'remastered',
  'restored', 'colorized', 'color', 'colour', 'bw', 'part', 'reel', 'edition', 'version']);
const ARTICLES = new Set(['the', 'a', 'an', 'le', 'la', 'les', 'los', 'las', 'il', 'lo',
  'der', 'die', 'das', 'ein', 'eine', 'de', 'het', 'een', "l'"]);

function articleFront(title) {
  const m = String(title || '').match(/^(.*),\s*([\p{L}']+)$/u);
  if (m && ARTICLES.has(m[2].toLowerCase())) {
    const art = m[2];
    return art.endsWith("'") ? art + m[1] : `${art} ${m[1]}`;
  }
  return title || '';
}
function norm(s) {
  return String(s || '').toLowerCase().normalize('NFKD')
    .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}
function tokens(s) { return norm(s).split(' ').filter((t) => t && !STOP.has(t)); }

async function fetchJSON(url, ms = 8000) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'tspdt-cinema/1.0' } });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; } finally { clearTimeout(to); }
}

function titleMatches(want, got) {
  const g = tokens(got);
  if (g.some((t) => BLOCK.has(t))) return false;       // reject reviews/reactions/etc.
  const w = tokens(want);
  if (!w.length) return false;
  const gset = new Set(g);
  if (!w.every((t) => gset.has(t))) return false;       // every title word must be present
  if (w.join('').length < 4) {                          // guard tiny titles ("M", "Up")
    const core = g.filter((t) => !/^\d+$/.test(t) && !FORMAT.has(t));
    return core.join('') === w.join('');
  }
  return true;
}

async function lookupIA(film) {
  const display = articleFront(film.title);
  const q = `title:(${norm(display)}) AND mediatype:movies`;
  const search = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(q)}` +
    `&fl[]=identifier&fl[]=title&fl[]=year&rows=12&output=json`;
  const data = await fetchJSON(search);
  const docs = data?.response?.docs || [];
  const year = /^\d{4}$/.test(film.year || '') ? +film.year : null;

  const ranked = docs
    .map((d) => {
      const yr = parseInt(String(d.year || '').slice(0, 4), 10);
      const yearOk = !year || Number.isNaN(yr) || Math.abs(yr - year) <= 1;
      return { d, ok: titleMatches(display, d.title) && yearOk, yr };
    })
    .filter((x) => x.ok);

  for (const { d } of ranked.slice(0, 8)) {
    const meta = await fetchJSON(`https://archive.org/metadata/${d.identifier}`);
    const m = meta?.metadata;
    if (!m || m['access-restricted-item'] === 'true') continue;
    if (m.mediatype && m.mediatype !== 'movies') continue;
    let coll = m.collection;
    coll = Array.isArray(coll) ? coll : coll ? [coll] : [];
    if (coll.some((c) => DENY_COLL.has(c))) continue;              // clearly not a PD feature film
    if (!coll.some((c) => ALLOW_COLL.has(c))) continue;           // must be in a film collection
    // positive legal signal: curated feature_films, or a genuine open/PD license
    if (!coll.includes('feature_films') && !isOpenLicense(m.licenseurl)) continue;
    const files = meta.files || [];
    const vid = files.find((f) => /mpeg4|h\.264|matroska|ogg video|webm/i.test(f.format || '') && VIDEO_RE.test(f.name))
             || files.find((f) => VIDEO_RE.test(f.name) && !f.name.startsWith('__'));
    if (vid) {
      return {
        available: true,
        identifier: d.identifier,
        watch: `https://archive.org/embed/${d.identifier}`,
        download: `https://archive.org/download/${d.identifier}/${encodeURIComponent(vid.name)}`,
        downloadName: vid.name,
        source: 'Internet Archive'
      };
    }
  }
  return { available: false };
}

export async function getAvailability(film) {
  const cached = getCachedAvailability(film.id_tspdt);
  if (cached) {
    const age = Date.now() - Date.parse(cached.checked_at + 'Z');
    const fresh = cached.available ? age < POS_TTL_MS : age < NEG_TTL_MS;
    if (fresh) {
      return {
        available: !!cached.available, source: 'Internet Archive',
        identifier: cached.identifier, watch: cached.watch,
        download: cached.download, downloadName: cached.download_name
      };
    }
  }
  const result = await lookupIA(film);
  cacheAvailability(film.id_tspdt, result);
  return { source: 'Internet Archive', ...result };
}
