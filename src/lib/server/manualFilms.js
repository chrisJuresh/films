import { env } from '$env/dynamic/private';
import { addManualFilm, existingFilmsByTmdb } from './db.js';
import { getTmdbMovie, normaliseTmdbMovie, searchTmdbMovies } from './tmdbClient.js';

export async function searchManualFilms(query) {
  const results = await searchTmdbMovies(query, env.TSPDT_TMDB_KEY);
  const existing = existingFilmsByTmdb(results.map((r) => r.tmdb_id));
  return results.map((r) => ({ ...r, existing_id: existing[r.tmdb_id] ?? null }));
}
export async function createManualFilm(user, tmdbId) {
  // The cheap preflight avoids a second TMDB request for an exact manual/audit
  // match. addManualFilm repeats every duplicate check inside its transaction.
  const known = existingFilmsByTmdb([tmdbId]);
  if (known[tmdbId] != null) return { id: known[tmdbId], created: false };
  const details = await getTmdbMovie(tmdbId, env.TSPDT_TMDB_KEY);
  return addManualFilm(user, normaliseTmdbMovie(details));
}
