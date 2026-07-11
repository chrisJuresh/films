import { env } from '$env/dynamic/private';
import { downloadWithRadarrClient, radarrStatus, movieFileInfo, cancelDownload, libraryState, searchReleases, grabRelease, pushRelease, manualImport, ensureMovie, movieDownloadIds, RadarrError } from './radarrClient.js';
import { searchProwlarr, prowlarrEnabled, prowlarrDownNote } from './prowlarr.js';
import { qbEnabled, grabToQb, qbProgressForMovie, qbTorrentsForMovie, exportTorrent, setImporter, startPump } from './qbittorrent.js';
import { syncFilmDownloads } from './db.js';

export { RadarrError };

function config() {
  const rawUrl = env.RADARR_URL?.trim();
  const apiKey = env.RADARR_API_KEY?.trim();
  const rootFolderPath = env.RADARR_ROOT_FOLDER?.trim();
  const qualityProfileId = Number(env.RADARR_QUALITY_PROFILE_ID);

  if (!rawUrl || !apiKey || !rootFolderPath || !env.RADARR_QUALITY_PROFILE_ID?.trim()) {
    throw new RadarrError('Radarr is not configured on this server.', 503);
  }
  if (!Number.isInteger(qualityProfileId) || qualityProfileId < 1) {
    throw new RadarrError('RADARR_QUALITY_PROFILE_ID must be a positive integer.', 503);
  }

  let baseUrl;
  try {
    baseUrl = new URL(rawUrl.replace(/\/+$/, '') + '/');
  } catch {
    throw new RadarrError('RADARR_URL is not a valid URL.', 503);
  }
  if (!['http:', 'https:'].includes(baseUrl.protocol)) {
    throw new RadarrError('RADARR_URL must use HTTP or HTTPS.', 503);
  }

  return { baseUrl, apiKey, rootFolderPath, qualityProfileId };
}

// Pick the best release for an automatic grab: highest resolution, then seeders.
function bestByQuality(releases) {
  const rank = (q) => {
    const s = (q || '').toLowerCase();
    if (s.includes('2160') || s.includes('4k') || s.includes('uhd')) return 4;
    if (s.includes('1080')) return 3;
    if (s.includes('720')) return 2;
    if (s.includes('480')) return 1;
    return 0;
  };
  return [...(releases || [])].sort((a, b) => (rank(b.quality) - rank(a.quality)) || ((b.seeders || 0) - (a.seeders || 0)))[0] || null;
}

// Indexers match short titles far better than long festival ones, e.g.
// "Jeanne Dielman, 23, quai du Commerce, 1080 Bruxelles" → "Jeanne Dielman".
const cleanQuery = (t) => ((t || '').split(/[,:(]/)[0].trim() || (t || ''));

// The "Download" button. Radarr's normal add + auto-search first; but Radarr
// searches indexers on TMDB's year, so year-mismatched films (e.g. festival
// premiere vs theatrical release) find nothing. In that case fall back to a
// Prowlarr search on OUR catalogue year and grab the best result, pushed back
// through Radarr so it still imports/renames.
export async function downloadWithRadarr(imdbId, year) {
  const cfg = config();
  const res = await downloadWithRadarrClient(imdbId, cfg, undefined, { year });
  if (res.status === 'available' || !res.yearMismatch || !prowlarrEnabled()) return res;
  let rr, pw;
  try { rr = await searchReleases(imdbId, cfg, { year }); } catch { return res; }
  if (rr.releases.some((r) => !r.rejected)) return res;     // Radarr can grab one itself
  try { pw = await searchProwlarr(cleanQuery(rr.title), year); } catch { pw = []; }
  const pick = bestByQuality(pw);
  if (!pick) return { ...res, prowlarrFound: 0, grabFailed: (await prowlarrDownNote()) || 'No releases found for this film right now.' };
  try {
    await pushRelease(pick, cfg);
    return { status: 'queued', title: rr.title, radarrId: res.radarrId, via: 'prowlarr', grabbed: pick.title };
  } catch (e) {
    // Radarr couldn't map the release title. Last resort: add it to qBittorrent
    // directly and force-import it into Radarr by movie id once it finishes.
    if (qbEnabled() && res.radarrId) {
      try {
        await grabToQb(pick, res.radarrId);
        return { status: 'queued', title: rr.title, radarrId: res.radarrId, via: 'qbittorrent', grabbed: pick.title };
      } catch (qe) {
        return { ...res, prowlarrFound: pw.length, grabFailed: qe?.message || e?.message };
      }
    }
    return { ...res, prowlarrFound: pw.length, grabFailed: e?.message || 'Radarr could not grab the release.' };
  }
}

export async function getRadarrStatus(imdbId) {
  const s = await radarrStatus(imdbId, config());
  // qB-direct downloads aren't in Radarr's queue, so surface their progress too.
  if (s?.present && !s.hasFile && !s.queue && s.movieId && qbEnabled()) {
    try { const q = await qbProgressForMovie(s.movieId); if (q) s.qb = q; } catch { /* best-effort */ }
  }
  return s;
}

export function getMovieFileInfo(imdbId) {
  return movieFileInfo(imdbId, config());
}

export function cancelRadarr(imdbId) {
  return cancelDownload(imdbId, config());
}

// Interactive release list for the picker. Radarr's own search first; if it
// finds nothing (usually a TMDB-vs-release year mismatch, which Radarr can't be
// made to search around), fall back to a Prowlarr text search on our catalogue
// year — but only if Prowlarr is configured.
export async function getReleases(imdbId, year) {
  const rr = await searchReleases(imdbId, config(), { year });
  if (rr.releases.length > 0 || !prowlarrEnabled()) {
    return { releases: rr.releases, source: 'radarr' };
  }
  try {
    const pw = await searchProwlarr(cleanQuery(rr.title), year);
    return { releases: pw, source: pw.length ? 'prowlarr' : 'radarr', fallback: true, note: pw.length ? null : await prowlarrDownNote() };
  } catch {
    return { releases: [], source: 'radarr', fallback: true };   // Prowlarr down → no fallback, not an error
  }
}

export function grabReleaseFor(guid, indexerId) {
  return grabRelease(guid, indexerId, config());
}

// Grab a Prowlarr-sourced release: push it through Radarr if it can map the
// title, else fall back to qBittorrent-direct + forced import (for titles the
// parser can't handle). `imdbId`/`year` locate the movie for the qB path.
export async function grabProwlarrRelease(imdbId, year, release) {
  const cfg = config();
  try {
    await pushRelease(release, cfg);
    return { grabbed: true, via: 'radarr' };
  } catch (e) {
    if (!qbEnabled()) throw e;
    const movieId = await ensureMovie(imdbId, cfg);
    await grabToQb(release, movieId);
    return { grabbed: true, via: 'qbittorrent' };
  }
}

// For the in-library "Download" menu: the film's ACTUAL torrent(s) on the server
// (in qBittorrent) — matched by our movie tag or by a Radarr download hash — each
// with its full name + a magnet. Not a fresh indexer search.
export async function serverTorrentsFor(imdbId) {
  if (!qbEnabled()) return [];
  const cfg = config();
  let movieId = null, hashes = [];
  try {
    const s = await radarrStatus(imdbId, cfg);
    movieId = s?.movieId || null;
    if (movieId) hashes = await movieDownloadIds(movieId, cfg);
  } catch { /* Radarr optional; qB tag match still works */ }
  return qbTorrentsForMovie(movieId, hashes);
}

// Export a specific torrent's .torrent bytes (+ name) from qBittorrent.
export function exportTorrentFor(hash) {
  return exportTorrent(hash);
}

// Resume the qBittorrent import pump (and wire its Radarr force-import) when the
// module loads, so completed downloads still import after a server restart.
if (qbEnabled()) {
  setImporter((movieId, path) => manualImport(movieId, path, config()));
  startPump();
}

// Refresh the film_download snapshot from Radarr's library, at most every 45s.
// Fire-and-forget + graceful: a missing/unreachable Radarr just leaves the last
// snapshot in place.
let _lastDownloadSync = 0;
export async function refreshDownloadState() {
  if (Date.now() - _lastDownloadSync < 45000) return;
  _lastDownloadSync = Date.now();
  try { syncFilmDownloads(await libraryState(config())); } catch { /* radarr off/unreachable */ }
}
