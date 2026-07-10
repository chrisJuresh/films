import { json, error } from '@sveltejs/kit';
import { setStatus } from '$lib/server/db.js';

const KINDS = new Set(['watchlist', 'seen', 'rewatch', 'unfinished']);

// { id_tspdt, kind: 'watchlist'|'seen'|'rewatch'|'unfinished', on: boolean }
export async function POST({ request, locals }) {
  const { id_tspdt, kind, on } = await request.json();
  if (!id_tspdt || !KINDS.has(kind)) throw error(400, 'id_tspdt and a valid kind required');
  return json(setStatus(locals.user, +id_tspdt, kind, !!on));
}
