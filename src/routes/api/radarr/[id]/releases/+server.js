import { json, error } from '@sveltejs/kit';
import { getFilmBasic } from '$lib/server/db.js';
import { getReleases, grabReleaseFor, RadarrError } from '$lib/server/radarr.js';

// GET: interactive search → candidate releases. POST {guid, indexerId}: grab one.
export async function GET({ params }) {
  const id = Number(params.id);
  const film = id > 0 ? getFilmBasic(id) : null;
  if (!film?.imdb_id) throw error(404, 'Film not found.');
  try {
    return json(await getReleases(film.imdb_id, film.year));
  } catch (cause) {
    throw error(cause instanceof RadarrError ? cause.status : 502, cause?.message || 'Radarr search failed.');
  }
}

export async function POST({ request }) {
  const { guid, indexerId } = await request.json().catch(() => ({}));
  if (!guid) throw error(400, 'A release guid is required.');
  try {
    return json(await grabReleaseFor(guid, indexerId));
  } catch (cause) {
    throw error(cause instanceof RadarrError ? cause.status : 502, cause?.message || 'Could not grab that release.');
  }
}
