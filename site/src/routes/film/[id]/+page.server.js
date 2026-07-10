import { error } from '@sveltejs/kit';
import { getFilm } from '$lib/server/db.js';

export function load({ params }) {
  const film = getFilm(+params.id);
  if (!film) throw error(404, 'Film not found');
  return { film };
}
