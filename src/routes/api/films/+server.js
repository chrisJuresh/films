import { json } from '@sveltejs/kit';
import { queryFilms } from '$lib/server/db.js';

export function GET({ url, locals }) {
  const p = Object.fromEntries(url.searchParams);
  return json(queryFilms({ ...p, user: locals.user }));
}
