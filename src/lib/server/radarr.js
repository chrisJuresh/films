import { env } from '$env/dynamic/private';
import { downloadWithRadarrClient, radarrStatus, movieFileInfo, cancelDownload, libraryState, searchReleases, grabRelease, pushRelease, RadarrError } from './radarrClient.js';
import { searchProwlarr, prowlarrEnabled } from './prowlarr.js';
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
  if (rr.releases.length > 0) return res;                   // Radarr can find it after all
  try { pw = await searchProwlarr(rr.title, year); } catch { return res; }
  const pick = bestByQuality(pw);
  if (!pick) return res;                                    // nothing on Prowlarr either
  try {
    await pushRelease(pick, cfg);
    return { status: 'queued', title: rr.title, radarrId: res.radarrId, via: 'prowlarr', grabbed: pick.title };
  } catch (e) {
    // Found releases on Prowlarr but Radarr couldn't auto-grab one (e.g. a title
    // its parser mis-reads). Surface that honestly instead of a silent "Missing".
    return { ...res, prowlarrFound: pw.length, grabFailed: e?.message || 'Radarr could not grab the release.' };
  }
}

export function getRadarrStatus(imdbId) {
  return radarrStatus(imdbId, config());
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
    const pw = await searchProwlarr(rr.title, year);
    return { releases: pw, source: pw.length ? 'prowlarr' : 'radarr', fallback: true };
  } catch {
    return { releases: [], source: 'radarr' };   // Prowlarr down → no fallback, not an error
  }
}

export function grabReleaseFor(guid, indexerId) {
  return grabRelease(guid, indexerId, config());
}

// Grab a Prowlarr-sourced release by pushing it into Radarr's pipeline.
export function pushReleaseFor(release) {
  return pushRelease(release, config());
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
