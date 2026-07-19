import { error, json } from '@sveltejs/kit';
import { createManualFilm, searchManualFilms } from '$lib/server/manualFilms.js';
import { TmdbError } from '$lib/server/tmdbClient.js';

function fail(cause) {
  if (cause instanceof TmdbError) throw error(cause.status, cause.message);
  console.error('manual film request failed', cause);
  throw error(500, 'The film could not be added.');
}

export async function GET({ url }) {
  const q = String(url.searchParams.get('q') || '').trim();
  if (q.length < 2) return json({ items: [] });
  if (q.length > 100) throw error(400, 'Search text is too long.');
  try { return json({ items: await searchManualFilms(q) }); }
  catch (cause) { fail(cause); }
}

export async function POST({ request, locals }) {
  let body;
  try { body = await request.json(); }
  catch { throw error(400, 'A movie selection is required.'); }
  const tmdbId = Number(body?.tmdb_id);
  if (!Number.isSafeInteger(tmdbId) || tmdbId <= 0) throw error(400, 'A valid movie selection is required.');
  try {
    const result = await createManualFilm(locals.user, tmdbId);
    return json(result, { status: result.created ? 201 : 200 });
  }
  catch (cause) { fail(cause); }
}
