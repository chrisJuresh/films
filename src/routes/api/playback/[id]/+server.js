import { json, error } from '@sveltejs/kit';
import { setPlayback } from '$lib/server/db.js';

// Persist the viewer's position in a film (per Cloudflare-Access user).
export async function POST({ params, request, locals }) {
  const id = Number(params.id);
  if (!(id > 0)) throw error(400, 'A valid film id is required.');
  const { position, duration } = await request.json().catch(() => ({}));
  if (typeof position !== 'number' || !(position >= 0)) throw error(400, 'position (seconds) is required.');
  setPlayback(locals.user, id, position, typeof duration === 'number' ? duration : null);
  return json({ ok: true });
}
