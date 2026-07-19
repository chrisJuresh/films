import { env } from '$env/dynamic/private';
import * as qb from './qbittorrentClient.js';
import { QbError } from './qbittorrentClient.js';

export { QbError };

// The qBittorrent-direct pipeline: a last resort for releases Radarr can't grab
// itself (titles its parser can't map to a movie). We add the torrent here with
// two tags — IMPORT_TAG (still needs importing) and films-movie-<id> (which movie
// it's for) — then a background pump force-imports finished downloads into Radarr
// by movie id and drops IMPORT_TAG. Optional: without QBITTORRENT_* env it's off.
const CATEGORY = 'films';
const IMPORT_TAG = 'films-import';
const movieTag = (id) => `films-movie-${id}`;
const tagMovieId = (tags) => { const m = /films-movie-(\d+)/.exec(tags || ''); return m ? Number(m[1]) : null; };

function config() {
  const rawUrl = env.QBITTORRENT_URL?.trim();
  const username = env.QBITTORRENT_USER?.trim();
  const password = env.QBITTORRENT_PASS ?? '';
  if (!rawUrl || !username) return null;
  let baseUrl;
  try { baseUrl = new URL(rawUrl.replace(/\/+$/, '') + '/'); } catch { return null; }
  if (!['http:', 'https:'].includes(baseUrl.protocol)) return null;
  return { baseUrl, username, password };
}
export function qbEnabled() { return !!config(); }

// Cache the session cookie; drop + re-login on any failure.
let _cookie = null;
async function cookie(cfg) {
  if (!_cookie) _cookie = await qb.login(cfg, fetch);
  return _cookie;
}

/** Add a release straight to qBittorrent, tagged for import into `movieId`.
 *  Throws (rather than pretending success) if it can't obtain a real torrent,
 *  so the caller can move on to another release. */
export async function grabToQb(release, movieId) {
  const cfg = config();
  if (!cfg) throw new QbError('qBittorrent is not configured.', 503);
  const dl = release?.downloadUrl, magnet = release?.magnetUrl;
  if (!dl && !magnet) throw new QbError('That release has no download link.', 422);
  // Fetch the .torrent ourselves (a FILE upload is synchronous + reliable, unlike
  // a URL hand-off) and verify it really is one before trusting it.
  let buf = null;
  if (dl && /^https?:/i.test(dl)) {
    try { const r = await fetch(dl); if (r.ok) buf = Buffer.from(await r.arrayBuffer()); } catch { /* validated below */ }
  }
  const src = qb.torrentSource(buf, magnet);
  if (!src) throw new QbError('Could not fetch a usable .torrent for that release.', 502);
  const tags = `${IMPORT_TAG},${movieTag(movieId)}`;
  const run = async () => {
    const c = await cookie(cfg);
    await qb.createCategory(cfg, CATEGORY, c, fetch);
    if (src.torrentFile) await qb.addTorrent(cfg, { torrentFile: src.torrentFile, filename: `film-${movieId}.torrent`, category: CATEGORY, tags }, c, fetch);
    else await qb.addTorrent(cfg, { url: src.url, category: CATEGORY, tags }, c, fetch);
  };
  try { await run(); } catch { _cookie = null; await run(); }   // one retry after re-login
  // qB 5 may acknowledge an upload before the torrent appears in torrents/info.
  // Keep polling briefly even if the first list is empty, otherwise the pump can
  // stop in that small window and never wake when the download completes.
  startPump(90000);
  return { added: true };
}

/** qB download progress for a film's in-flight torrent, or null. */
export async function qbProgressForMovie(movieId) {
  const cfg = config();
  if (!cfg) return null;
  try {
    const c = await cookie(cfg);
    const t = (await qb.listTorrents(cfg, { tag: movieTag(movieId) }, c, fetch))[0];
    if (!t) return null;
    return {
      progress: Math.round((t.progress || 0) * 100),
      state: t.state,
      done: qb.isComplete(t),
      eta: t.eta && t.eta < 8640000 ? t.eta : null,
      name: t.name
    };
  } catch { _cookie = null; return null; }
}

const tagList = (tags) => (tags || '').split(',').map((s) => s.trim()).filter(Boolean);

/** The film's actual torrent(s) in qBittorrent — matched by our movie tag OR by
 *  a Radarr download hash. Returns [{ hash, name, magnet }]. */
export async function qbTorrentsForMovie(movieId, hashes = []) {
  const cfg = config();
  if (!cfg) return [];
  const want = new Set((hashes || []).map((h) => String(h).toLowerCase()));
  const tag = movieId ? movieTag(movieId) : null;
  try {
    const c = await cookie(cfg);
    const all = await qb.listTorrents(cfg, {}, c, fetch);
    return all
      .filter((t) => (tag && tagList(t.tags).includes(tag)) || want.has(String(t.hash || '').toLowerCase()))
      .map((t) => ({ hash: t.hash, name: t.name, magnet: `magnet:?xt=urn:btih:${t.hash}&dn=${encodeURIComponent(t.name || '')}` }));
  } catch { _cookie = null; return []; }
}

/** Export a torrent's .torrent bytes from qBittorrent, with its name. */
export async function exportTorrent(hash) {
  const cfg = config();
  if (!cfg) return null;
  try {
    const c = await cookie(cfg);
    const info = await qb.listTorrents(cfg, {}, c, fetch);
    const t = info.find((x) => String(x.hash || '').toLowerCase() === String(hash).toLowerCase());
    const r = await fetch(new URL(`api/v2/torrents/export?hash=${encodeURIComponent(hash)}`, cfg.baseUrl), {
      headers: { Cookie: c, Referer: cfg.baseUrl.origin }
    });
    if (!r.ok) return null;
    return { bytes: Buffer.from(await r.arrayBuffer()), name: t?.name || String(hash) };
  } catch { _cookie = null; return null; }
}

// radarr.js injects the Radarr force-import so this module doesn't depend on it.
let _importFn = null;
export function setImporter(fn) { _importFn = fn; }

let pumpTimer = null, pumping = false, pumpGraceUntil = 0;
export function startPump(graceMs = 0) {
  if (!config() || !_importFn) return;
  pumpGraceUntil = Math.max(pumpGraceUntil, Date.now() + Math.max(0, Number(graceMs) || 0));
  if (!pumpTimer) pumpTimer = setInterval(runPump, 30000);
  runPump();
}

async function runPump() {
  if (pumping) return;
  pumping = true;
  try {
    const cfg = config();
    if (!cfg || !_importFn) return;
    let c, list;
    try { c = await cookie(cfg); list = await qb.listTorrents(cfg, { tag: IMPORT_TAG }, c, fetch); }
    catch { _cookie = null; return; }                       // retry next tick
    let pending = 0;
    for (const t of list) {
      if (!qb.isComplete(t)) { pending++; continue; }
      const movieId = tagMovieId(t.tags);
      if (!movieId) continue;
      try {
        await _importFn(movieId, t.content_path);
        await qb.setTags(cfg, t.hash, IMPORT_TAG, false, c, fetch);   // imported → stop tracking
      } catch (cause) {
        pending++;
        console.error(`qBittorrent import failed for movie ${movieId}; retrying:`, cause);
      }
    }
    if (!pending && Date.now() >= pumpGraceUntil && pumpTimer) {
      clearInterval(pumpTimer);
      pumpTimer = null;
    }
  } finally { pumping = false; }
}
