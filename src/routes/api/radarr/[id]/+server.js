import { json } from '@sveltejs/kit';
import { getFilmBasic } from '$lib/server/db.js';
import { downloadWithRadarr, getRadarrStatus, cancelRadarr, RadarrError } from '$lib/server/radarr.js';

// Live Radarr status for the film page (added? downloading? quality? errors?).
// Never throws to the client — an unconfigured/unreachable Radarr just yields
// { present: false } so the UI hides the panel gracefully.
export async function GET({ params }) {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id < 1) return json({ present: false });
  const film = getFilmBasic(id);
  if (!film?.imdb_id) return json({ present: false });
  try {
    return json(await getRadarrStatus(film.imdb_id));
  } catch (cause) {
    if (cause instanceof RadarrError && cause.status === 503) return json({ configured: false, present: false });
    return json({ present: false, unavailable: true });
  }
}

export async function POST({ params }) {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id < 1) {
    return json({ message: 'A valid film ID is required.' }, { status: 400 });
  }

  const film = getFilmBasic(id);
  if (!film) return json({ message: 'Film not found.' }, { status: 404 });

  try {
    return json(await downloadWithRadarr(film.imdb_id, film.year));
  } catch (cause) {
    if (cause instanceof RadarrError) {
      return json({ message: cause.message }, { status: cause.status });
    }
    console.error('Unexpected Radarr integration error:', cause);
    return json({ message: 'Could not send this film to Radarr.' }, { status: 500 });
  }
}

// Cancel an in-progress download (remove it from Radarr's queue + client).
export async function DELETE({ params }) {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id < 1) return json({ message: 'A valid film ID is required.' }, { status: 400 });
  const film = getFilmBasic(id);
  if (!film?.imdb_id) return json({ message: 'Film not found.' }, { status: 404 });
  try {
    return json(await cancelRadarr(film.imdb_id));
  } catch (cause) {
    if (cause instanceof RadarrError) return json({ message: cause.message }, { status: cause.status });
    return json({ message: 'Could not cancel the download.' }, { status: 500 });
  }
}
