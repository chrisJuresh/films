const API = 'https://api.themoviedb.org/3/';
const IMG = 'https://image.tmdb.org/t/p/';

export class TmdbError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'TmdbError';
    this.status = status;
  }
}
async function request(path, key, params = {}, fetchImpl = fetch) {
  if (!key) throw new TmdbError('TMDB is not configured.', 503);
  const url = new URL(path, API);
  url.searchParams.set('api_key', key);
  for (const [name, value] of Object.entries(params)) if (value != null) url.searchParams.set(name, String(value));
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: 'application/json', 'user-agent': 'tspdt-cinema/1.0' },
      signal: AbortSignal.timeout(9000)
    });
  } catch {
    throw new TmdbError('Movie search could not reach TMDB.');
  }
  if (response.status === 401) throw new TmdbError('TMDB rejected the configured API key.', 503);
  if (!response.ok) throw new TmdbError('TMDB could not complete the movie lookup.');
  try { return await response.json(); }
  catch { throw new TmdbError('TMDB returned an invalid response.'); }
}

export async function searchTmdbMovies(query, key, fetchImpl = fetch) {
  const q = String(query || '').trim().slice(0, 100);
  if (q.length < 2) return [];
  const data = await request('search/movie', key, {
    query: q, include_adult: false, language: 'en-GB', page: 1
  }, fetchImpl);
  return (Array.isArray(data?.results) ? data.results : []).slice(0, 8).map((m) => ({
    tmdb_id: Number(m.id),
    title: m.title || m.original_title || 'Untitled',
    original_title: m.original_title && m.original_title !== m.title ? m.original_title : null,
    year: /^\d{4}/.test(m.release_date || '') ? m.release_date.slice(0, 4) : null,
    overview: m.overview || null,
    poster: m.poster_path ? IMG + 'w185' + m.poster_path : null
  })).filter((m) => Number.isSafeInteger(m.tmdb_id) && m.tmdb_id > 0);
}

export async function getTmdbMovie(tmdbId, key, fetchImpl = fetch) {
  const id = Number(tmdbId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new TmdbError('A valid movie is required.', 400);
  return request(`movie/${id}`, key, {
    language: 'en-GB', append_to_response: 'credits,videos,release_dates,external_ids'
  }, fetchImpl);
}

export function normaliseTmdbMovie(d) {
  const tmdbId = Number(d?.id);
  if (!Number.isSafeInteger(tmdbId) || tmdbId <= 0 || !(d?.title || d?.original_title)) {
    throw new TmdbError('TMDB returned an incomplete movie record.');
  }
  const id = -tmdbId;
  const crew = Array.isArray(d.credits?.crew) ? d.credits.crew : [];
  const directors = crew.filter((c) => c.job === 'Director').map((c) => c.name).filter(Boolean);
  const writers = [...new Set(crew.filter((c) => ['Writer', 'Screenplay', 'Story'].includes(c.job)).map((c) => c.name).filter(Boolean))];
  const certifications = [];
  const seenCerts = new Set();
  for (const country of d.release_dates?.results || []) {
    for (const release of country.release_dates || []) {
      const cert = String(release.certification || '').trim();
      const code = String(country.iso_3166_1 || '').trim();
      const key = `${code}|${cert}`;
      if (cert && !seenCerts.has(key)) { seenCerts.add(key); certifications.push({ country: code, cert }); }
    }
  }
  const videos = Array.isArray(d.videos?.results) ? d.videos.results : [];
  const trailer = videos.find((v) => v.site === 'YouTube' && v.type === 'Trailer' && v.official)
    || videos.find((v) => v.site === 'YouTube' && v.type === 'Trailer')
    || videos.find((v) => v.site === 'YouTube');
  const imdbId = /^tt\d+$/.test(d.imdb_id || d.external_ids?.imdb_id || '')
    ? (d.imdb_id || d.external_ids.imdb_id) : null;
  const title = d.title || d.original_title;
  const year = /^\d{4}/.test(d.release_date || '') ? d.release_date.slice(0, 4) : null;
  const genres = (d.genres || []).map((g) => g.name).filter(Boolean);
  const countries = (d.production_countries || []).map((c) => c.name).filter(Boolean);
  const posterSrc = d.poster_path ? IMG + 'w500' + d.poster_path : null;
  const backdropSrc = d.backdrop_path ? IMG + 'w1280' + d.backdrop_path : null;
  const meta = {
    enabled: true,
    id_tspdt: id,
    imdb_id: imdbId,
    imdb_url: imdbId ? `https://www.imdb.com/title/${imdbId}/` : null,
    tmdb_id: tmdbId,
    tmdb_url: `https://www.themoviedb.org/movie/${tmdbId}`,
    poster_src: posterSrc,
    poster: posterSrc ? `/img/poster/${id}` : null,
    backdrop_src: backdropSrc,
    backdrop: backdropSrc ? `/img/backdrop/${id}` : null,
    overview: d.overview || null,
    tagline: d.tagline || null,
    tmdb_rating: Number(d.vote_average) || null,
    tmdb_votes: Number(d.vote_count) || null,
    runtime: Number(d.runtime) || null,
    genres,
    budget: Number(d.budget) || null,
    revenue: Number(d.revenue) || null,
    homepage: d.homepage || null,
    companies: (d.production_companies || []).map((c) => c.name).filter(Boolean),
    cast: (d.credits?.cast || []).slice(0, 14).map((c) => ({
      name: c.name, character: c.character || null,
      photo: c.profile_path ? IMG + 'w185' + c.profile_path : null
    })).filter((c) => c.name),
    directors,
    writers,
    trailer: trailer ? `https://www.youtube.com/watch?v=${trailer.key}` : null,
    certifications,
    certification: certifications.find((c) => c.country === 'GB')?.cert
      || certifications.find((c) => c.country === 'US')?.cert || certifications[0]?.cert || null,
    released: d.release_date || null,
    country: countries.join(', ') || null,
    language: (d.spoken_languages || []).map((l) => l.english_name || l.name).filter(Boolean).join(', ') || null
  };
  return {
    tmdbId,
    film: {
      imdb_id: imdbId,
      imdb_url: meta.imdb_url,
      title,
      year,
      director: directors.join(', ') || null,
      country: countries.join('-') || null,
      length_min: meta.runtime,
      colour: null,
      genre: genres.join('-') || null
    },
    meta,
    certs: certifications
  };
}
