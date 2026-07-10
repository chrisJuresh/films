import { json, error } from '@sveltejs/kit';
import { setStatus } from '$lib/server/db.js';

// { id_tspdt, kind: 'watchlist'|'seen', on: boolean }
export async function POST({ request, locals }) {
  const { id_tspdt, kind, on } = await request.json();
  if (!id_tspdt || (kind !== 'watchlist' && kind !== 'seen')) throw error(400, 'id_tspdt and kind (watchlist|seen) required');
  return json(setStatus(locals.user, +id_tspdt, kind, !!on));
}
