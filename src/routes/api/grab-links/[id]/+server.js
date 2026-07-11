import { json, error } from '@sveltejs/kit';
import { getFilmBasic } from '$lib/server/db.js';
import { grabLinksFor } from '$lib/server/radarr.js';

// { magnet, hasTorrent } for the in-library Download menu. Best-effort.
export async function GET({ params }) {
  const id = Number(params.id);
  const film = id > 0 ? getFilmBasic(id) : null;
  if (!film?.imdb_id) throw error(404, 'Film not found.');
  return json(await grabLinksFor(film.imdb_id, film.year, film.title));
}
