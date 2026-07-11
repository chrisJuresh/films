import { queryFilms } from '$lib/server/db.js';
import { refreshDownloadState } from '$lib/server/radarr.js';

// The download tracker. refreshDownloadState() pulls Radarr's latest view into
// the film_download snapshot (TTL-guarded to at most every 45s), then we read
// the four states straight back out. Polled from the client via invalidateAll().
export async function load({ locals }) {
  await refreshDownloadState();
  const list = (state) => queryFilms({ radarr: state, user: locals.user, limit: 120, sort: 'rank' }).items;
  return {
    downloading: list('downloading'),
    wanted: list('wanted'),
    errored: list('error'),
    downloaded: list('downloaded')
  };
}
