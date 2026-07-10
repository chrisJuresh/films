import { json, error } from '@sveltejs/kit';
import { getFilm } from '$lib/server/db.js';
import { getAvailability } from '$lib/server/ia.js';

export async function GET({ params, locals }) {
  const film = getFilm(+params.id, locals.user);
  if (!film) throw error(404, 'not found');
  const a = await getAvailability({ id_tspdt: film.id_tspdt, title: film.title, year: film.year });
  return json(a);
}
