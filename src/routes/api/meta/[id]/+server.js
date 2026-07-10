import { json, error } from '@sveltejs/kit';
import { getFilmBasic } from '$lib/server/db.js';
import { getMeta } from '$lib/server/meta.js';

export async function GET({ params, url }) {
  const film = getFilmBasic(+params.id);
  if (!film) throw error(404, 'not found');
  const level = url.searchParams.get('level') === 'light' ? 'light' : 'full';
  return json(await getMeta(film, level));
}
