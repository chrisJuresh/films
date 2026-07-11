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

/** Add a release straight to qBittorrent, tagged for import into `movieId`. */
export async function grabToQb(release, movieId) {
  const cfg = config();
  if (!cfg) throw new QbError('qBittorrent is not configured.', 503);
  const url = release?.downloadUrl || release?.magnetUrl;
  if (!url) throw new QbError('That release has no download link.', 422);
  const run = async () => {
    const c = await cookie(cfg);
    await qb.createCategory(cfg, CATEGORY, c, fetch);
    await qb.addTorrent(cfg, { url, category: CATEGORY, tags: `${IMPORT_TAG},${movieTag(movieId)}` }, c, fetch);
  };
  try { await run(); } catch { _cookie = null; await run(); }   // one retry after re-login
  startPump();
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

// radarr.js injects the Radarr force-import so this module doesn't depend on it.
let _importFn = null;
export function setImporter(fn) { _importFn = fn; }

let pumpTimer = null, pumping = false;
export function startPump() {
  if (!config() || !_importFn) return;
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
      } catch { pending++; }                                          // still moving / transient → retry
    }
    if (!pending && pumpTimer) { clearInterval(pumpTimer); pumpTimer = null; }
  } finally { pumping = false; }
}
