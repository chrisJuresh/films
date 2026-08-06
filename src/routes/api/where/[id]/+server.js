import { json, error } from '@sveltejs/kit';
import { getFilmBasic } from '$lib/server/db.js';
import { getWhereToWatch, regionFromHeaders, REGIONS } from '$lib/server/watch.js';

// Legal availability for a film. Returns every cached region plus the one this
// visitor most likely wants, so the client can offer a region switch without a
// second round trip.
export async function GET({ params, request }) {
  const film = getFilmBasic(+params.id);
  if (!film) throw error(404, 'not found');
  const data = await getWhereToWatch(film);
  return json({ ...data, region: regionFromHeaders(request.headers), regionNames: REGIONS });
}
