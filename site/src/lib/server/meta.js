// Server-only: enrich a film with everything reachable via its IMDb id.
// IMDb has no free public API, so we use two standard IMDb-id-keyed sources:
//   * OMDb  -> IMDb rating/votes, Rotten Tomatoes, Metacritic, plot, awards,
//              box office, certification, cast/director (the IMDb data itself)
//   * TMDB  -> poster & backdrop art, cast with photos, trailers, tagline,
//              budget/revenue, genres, production companies
// Results are merged into one object and cached in film_meta.
import { env } from '$env/dynamic/private';
import { getMetaCache, setMetaCache } from './db.js';

const IMG = 'https://image.tmdb.org/t/p/';
const TTL_MS = 30 * 24 * 3600 * 1000;

export function metaProviders() {
  return { tmdb: !!env.TSPDT_TMDB_KEY, omdb: !!env.TSPDT_OMDB_KEY, any: !!(env.TSPDT_TMDB_KEY || env.TSPDT_OMDB_KEY) };
}

async function fetchJSON(url, ms = 9000) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'tspdt-cinema/1.0' } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; } finally { clearTimeout(to); }
}
const na = (v) => (v && v !== 'N/A' ? v : null);

export async function getMeta(film, level = 'full') {
  const prov = metaProviders();
  if (!prov.any) return { enabled: false };

  const cached = getMetaCache(film.id_tspdt);
  const fresh = cached && Date.now() - Date.parse(cached.fetched_at + 'Z') < TTL_MS;
  if (cached && fresh && (cached.level === 'full' || level === 'light')) return JSON.parse(cached.json);

  const m = cached ? JSON.parse(cached.json) : { id_tspdt: film.id_tspdt };
  m.enabled = true;
  m.imdb_id = film.imdb_id;
  m.imdb_url = film.imdb_url || (film.imdb_id ? `https://www.imdb.com/title/${film.imdb_id}/` : null);
  let got = false;   // did any provider actually return data? (don't cache empty failures)

  /* ---- TMDB: art, cast, trailers, financials ---- */
  if (prov.tmdb && film.imdb_id) {
    const key = env.TSPDT_TMDB_KEY;
    const find = await fetchJSON(`https://api.themoviedb.org/3/find/${film.imdb_id}?external_source=imdb_id&api_key=${key}`);
    const hit = find?.movie_results?.[0] || find?.tv_results?.[0];
    if (hit) {
      got = true;
      m.tmdb_id = hit.id;
      m.tmdb_url = `https://www.themoviedb.org/movie/${hit.id}`;
      // Store the remote URL in *_src; expose the local cache path as poster/backdrop.
      if (hit.poster_path) { m.poster_src = IMG + 'w500' + hit.poster_path; m.poster = `/img/poster/${film.id_tspdt}`; }
      if (hit.backdrop_path) { m.backdrop_src = IMG + 'w1280' + hit.backdrop_path; m.backdrop = `/img/backdrop/${film.id_tspdt}`; }
      m.overview = m.overview || hit.overview || null;
      m.tmdb_rating = hit.vote_average || null;
      m.tmdb_votes = hit.vote_count || null;

      if (level === 'full') {
        const d = await fetchJSON(`https://api.themoviedb.org/3/movie/${hit.id}?api_key=${key}&append_to_response=credits,videos,release_dates`);
        if (d) {
          m.tagline = d.tagline || m.tagline || null;
          m.runtime = d.runtime || m.runtime || null;
          m.genres = d.genres?.length ? d.genres.map((g) => g.name) : m.genres;
          m.budget = d.budget || m.budget || null;
          m.revenue = d.revenue || m.revenue || null;
          m.homepage = d.homepage || m.homepage || null;
          m.overview = d.overview || m.overview || null;
          m.companies = d.production_companies?.map((c) => c.name) || m.companies;
          m.cast = (d.credits?.cast || []).slice(0, 14).map((c) => ({
            name: c.name, character: c.character,
            photo: c.profile_path ? IMG + 'w185' + c.profile_path : null
          }));
          const crew = d.credits?.crew || [];
          m.directors = crew.filter((c) => c.job === 'Director').map((c) => c.name);
          m.writers = [...new Set(crew.filter((c) => ['Writer', 'Screenplay', 'Story'].includes(c.job)).map((c) => c.name))];
          const vids = d.videos?.results || [];
          const tr = vids.find((v) => v.site === 'YouTube' && v.type === 'Trailer') || vids.find((v) => v.site === 'YouTube');
          if (tr) m.trailer = 'https://www.youtube.com/watch?v=' + tr.key;
          const us = (d.release_dates?.results || []).find((r) => r.iso_3166_1 === 'US');
          const cert = us?.release_dates?.map((x) => x.certification).find(Boolean);
          if (cert) m.certification = cert;
        }
      }
    }
  }

  /* ---- OMDb: IMDb rating & the rest (full only, to conserve the 1k/day quota) ---- */
  if (prov.omdb && film.imdb_id && level === 'full') {
    const o = await fetchJSON(`https://www.omdbapi.com/?i=${film.imdb_id}&apikey=${env.TSPDT_OMDB_KEY}&plot=full`);
    if (o && o.Response !== 'False') {
      got = true;
      m.imdb_rating = na(o.imdbRating);
      m.imdb_votes = na(o.imdbVotes);
      m.metascore = na(o.Metascore);
      const R = o.Ratings || [];
      m.rotten = na((R.find((x) => x.Source === 'Rotten Tomatoes') || {}).Value);
      m.metacritic = na((R.find((x) => x.Source === 'Metacritic') || {}).Value);
      m.plot = na(o.Plot);
      m.overview = m.overview || na(o.Plot);
      m.awards = na(o.Awards);
      m.box_office = na(o.BoxOffice);
      m.certification = m.certification || na(o.Rated);
      m.language = na(o.Language);
      m.country = na(o.Country);
      m.released = na(o.Released);
      m.production = na(o.Production);
      if (!m.poster && na(o.Poster)) { m.poster_src = o.Poster; m.poster = `/img/poster/${film.id_tspdt}`; }  // IMDb image fallback
      if (!m.genres && na(o.Genre)) m.genres = o.Genre.split(',').map((s) => s.trim());
      if (!m.directors?.length && na(o.Director)) m.directors = o.Director.split(',').map((s) => s.trim());
      if (!m.writers?.length && na(o.Writer)) m.writers = o.Writer.split(',').map((s) => s.trim());
      if (!m.cast?.length && na(o.Actors)) m.cast = o.Actors.split(',').map((s) => ({ name: s.trim() }));
      if (!m.runtime && na(o.Runtime)) { const r = parseInt(o.Runtime, 10); if (!Number.isNaN(r)) m.runtime = r; }
    }
  }

  // Only cache when a provider actually returned data, so a transient failure
  // (bad key, quota, network) doesn't freeze an empty result for 30 days.
  if (got) setMetaCache(film.id_tspdt, m, level === 'full' ? 'full' : (cached?.level || 'light'));
  return m;
}
