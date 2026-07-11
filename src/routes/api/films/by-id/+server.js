import { json } from '@sveltejs/kit';
import { filmsByIds } from '$lib/server/db.js';

// Resolve basic film rows for a comma-separated ?ids= list. The desktop app's
// download tracker uses this to label locally-saved films by id.
export function GET({ url }) {
  const ids = (url.searchParams.get('ids') || '').split(',').map(Number).filter(Number.isInteger);
  return json(filmsByIds(ids));
}
