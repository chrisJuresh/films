import { json } from '@sveltejs/kit';
import { queryFilms } from '$lib/server/db.js';

export function GET({ url }) {
  const p = Object.fromEntries(url.searchParams);
  return json(queryFilms(p));
}
