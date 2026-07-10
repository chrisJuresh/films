import { env } from '$env/dynamic/private';
import { downloadWithRadarrClient, radarrStatus, movieFileInfo, cancelDownload, RadarrError } from './radarrClient.js';

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

export function downloadWithRadarr(imdbId, year) {
  return downloadWithRadarrClient(imdbId, config(), undefined, { year });
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
