// Server-only: download poster/backdrop art ONCE and keep it permanently on
// local disk, so the app never re-fetches from TMDB after the first view.
// The remote URL lives in film_meta (from meta.js); this streams a local copy,
// downloading + saving on the first miss.
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, renameSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { getMetaCache } from './db.js';

const CACHE_DIR = process.env.TSPDT_IMG_DIR || resolve(process.cwd(), '.postercache');
const KINDS = new Set(['poster', 'backdrop']);
// Only ever fetch art from known image hosts (TMDB + the Amazon/IMDb CDNs OMDb
// returns). Prevents SSRF via a stray/hostile URL landing in film_meta.
const ALLOWED_HOSTS = new Set([
  'image.tmdb.org', 'm.media-amazon.com', 'images-na.ssl-images-amazon.com', 'ia.media-imdb.com'
]);

function safeUrl(u) {
  try { const url = new URL(u); return url.protocol === 'https:' && ALLOWED_HOSTS.has(url.hostname) ? url.href : null; }
  catch { return null; }
}
function localPath(kind, id) { return resolve(CACHE_DIR, kind, `${id}.jpg`); }

/** Returns { buffer, contentType } for a cached image, or null. Downloads on miss. */
export async function getImage(kind, id) {
  if (!KINDS.has(kind) || !Number.isInteger(id)) return null;
  const path = localPath(kind, id);
  if (existsSync(path) && statSync(path).size > 0) {
    return { buffer: readFileSync(path), contentType: 'image/jpeg' };
  }
  const cached = getMetaCache(id);
  if (!cached) return null;
  let meta;
  try { meta = JSON.parse(cached.json); } catch { return null; }
  const url = safeUrl(kind === 'poster' ? meta.poster_src : meta.backdrop_src);
  if (!url) return null;
  try {
    const res = await fetch(url, { redirect: 'error', headers: { 'User-Agent': 'tspdt-cinema/1.0' } });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!ct.startsWith('image/')) return null;               // only cache/serve genuine images
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length < 100) return null;
    mkdirSync(dirname(path), { recursive: true });
    // atomic: write to a unique temp file then rename, so a crash/ENOSPC never
    // leaves a truncated file that would be served forever.
    const tmp = `${path}.${Date.now()}-${Math.round(Math.random() * 1e9)}.tmp`;
    writeFileSync(tmp, buffer);
    renameSync(tmp, path);
    return { buffer, contentType: ct };
  } catch {
    return null;
  }
}
