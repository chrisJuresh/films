import { json, error } from '@sveltejs/kit';
import { setStatus } from '$lib/server/db.js';

export async function POST({ request }) {
  const { id_tspdt, status } = await request.json();
  if (!id_tspdt) throw error(400, 'id_tspdt required');
  return json(setStatus(+id_tspdt, status));
}
