import { json } from '@sveltejs/kit';
import { getFilmBasic } from '$lib/server/db.js';
import { downloadWithRadarr, RadarrError } from '$lib/server/radarr.js';

export async function POST({ params }) {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id < 1) {
    return json({ message: 'A valid film ID is required.' }, { status: 400 });
  }

  const film = getFilmBasic(id);
  if (!film) return json({ message: 'Film not found.' }, { status: 404 });

  try {
    return json(await downloadWithRadarr(film.imdb_id));
  } catch (cause) {
    if (cause instanceof RadarrError) {
      return json({ message: cause.message }, { status: cause.status });
    }
    console.error('Unexpected Radarr integration error:', cause);
    return json({ message: 'Could not send this film to Radarr.' }, { status: 500 });
  }
}
