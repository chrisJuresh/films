import { json, error } from '@sveltejs/kit';
import { getFilmBasic } from '$lib/server/db.js';
import { getReleases, grabReleaseFor, grabProwlarrRelease, RadarrError } from '$lib/server/radarr.js';

// GET: interactive search (Radarr, with a Prowlarr year-fallback) → candidates.
// POST: grab one — a Radarr release by {guid, indexerId}, or a Prowlarr release
// (source: 'prowlarr') pushed into Radarr so it still imports.
export async function GET({ params }) {
  const id = Number(params.id);
  const film = Number.isSafeInteger(id) && id !== 0 ? getFilmBasic(id) : null;
  if (!film?.imdb_id) throw error(404, 'Film not found.');
  try {
    return json(await getReleases(film.imdb_id, film.year));
  } catch (cause) {
    throw error(cause instanceof RadarrError ? cause.status : 502, cause?.message || 'Radarr search failed.');
  }
}

export async function POST({ params, request }) {
  const body = await request.json().catch(() => ({}));
  try {
    if (body.source === 'prowlarr') {
      const id = Number(params.id);
      const film = Number.isSafeInteger(id) && id !== 0 ? getFilmBasic(id) : null;
      if (!film?.imdb_id) throw error(404, 'Film not found.');
      return json(await grabProwlarrRelease(film.imdb_id, film.year, body));
    }
    if (!body.guid) throw error(400, 'A release guid is required.');
    return json(await grabReleaseFor(body.guid, body.indexerId));
  } catch (cause) {
    if (cause?.status && cause?.body) throw cause;   // re-throw SvelteKit error()
    throw error(cause instanceof RadarrError ? cause.status : 502, cause?.message || 'Could not grab that release.');
  }
}
