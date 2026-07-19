import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { normaliseTmdbMovie, searchTmdbMovies } from '../src/lib/server/tmdbClient.js';

const movie = {
  id: 1184918,
  title: 'The Wild Robot',
  original_title: 'The Wild Robot',
  release_date: '2024-09-12',
  overview: 'A robot learns to live on a wild island.',
  tagline: 'Discover your true nature.',
  poster_path: '/poster.jpg',
  backdrop_path: '/backdrop.jpg',
  vote_average: 8.3,
  vote_count: 4200,
  runtime: 102,
  budget: 78000000,
  revenue: 330000000,
  imdb_id: 'tt29623480',
  genres: [{ name: 'Animation' }, { name: 'Family' }],
  production_countries: [{ name: 'United States of America' }],
  production_companies: [{ name: 'DreamWorks Animation' }],
  spoken_languages: [{ english_name: 'English' }],
  credits: {
    crew: [{ job: 'Director', name: 'Chris Sanders' }, { job: 'Writer', name: 'Chris Sanders' }],
    cast: [{ name: 'Lupita Nyong’o', character: 'Roz', profile_path: '/roz.jpg' }]
  },
  videos: { results: [{ site: 'YouTube', type: 'Trailer', official: true, key: 'abc123' }] },
  release_dates: { results: [{ iso_3166_1: 'GB', release_dates: [{ certification: 'U' }] }] }
};

test('TMDB search is bounded and maps safe UI fields', async () => {
  let requested;
  const fetch = async (url) => {
    requested = url;
    return new Response(JSON.stringify({ results: [movie] }), { status: 200 });
  };
  const results = await searchTmdbMovies('  Wild Robot  ', 'secret', fetch);
  assert.equal(requested.pathname, '/3/search/movie');
  assert.equal(requested.searchParams.get('query'), 'Wild Robot');
  assert.equal(requested.searchParams.get('include_adult'), 'false');
  assert.deepEqual(results, [{
    tmdb_id: 1184918,
    title: 'The Wild Robot',
    original_title: null,
    year: '2024',
    overview: 'A robot learns to live on a wild island.',
    poster: 'https://image.tmdb.org/t/p/w185/poster.jpg'
  }]);
});
test('TMDB details normalise into a complete manual catalogue record', () => {
  const record = normaliseTmdbMovie(movie);
  assert.equal(record.tmdbId, 1184918);
  assert.equal(record.film.imdb_id, 'tt29623480');
  assert.equal(record.film.director, 'Chris Sanders');
  assert.equal(record.film.genre, 'Animation-Family');
  assert.equal(record.meta.poster, '/img/poster/-1184918');
  assert.equal(record.meta.trailer, 'https://www.youtube.com/watch?v=abc123');
  assert.deepEqual(record.certs, [{ country: 'GB', cert: 'U' }]);
});

const dbDir = mkdtempSync(join(tmpdir(), 'films-manual-test-'));
const dbPath = join(dbDir, 'catalogue.db');
const seed = new DatabaseSync(dbPath);
seed.exec(`
  PRAGMA foreign_keys=ON;
  CREATE TABLE editions (edition_id INTEGER PRIMARY KEY, label TEXT, poll_year INTEGER, poll_date TEXT);
  CREATE TABLE films (
    id_tspdt INTEGER PRIMARY KEY, imdb_id TEXT, imdb_url TEXT, is_new INTEGER NOT NULL DEFAULT 0,
    director TEXT, title TEXT, year TEXT, country TEXT, length_min INTEGER, colour TEXT, genre TEXT,
    latest_rank INTEGER, latest_edition_id INTEGER REFERENCES editions(edition_id), content_hash TEXT NOT NULL,
    first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, removed_at TEXT
  );
  CREATE TABLE rankings (
    id_tspdt INTEGER NOT NULL REFERENCES films(id_tspdt) ON DELETE CASCADE,
    edition_id INTEGER NOT NULL REFERENCES editions(edition_id) ON DELETE CASCADE,
    position INTEGER NOT NULL, PRIMARY KEY(id_tspdt,edition_id)
  );
  INSERT INTO editions VALUES(1,'2026',2026,'2026-01-01');
  INSERT INTO films VALUES(1,'tt0000001','https://www.imdb.com/title/tt0000001/',0,'Ranked Director',
    'Zulu','2001','USA',100,'Col','Drama',1,1,'ranked','2026-01-01','2026-01-01',NULL);
`);
seed.close();
process.env.TSPDT_DB = dbPath;
const { addManualFilm, getFilm, queryFilms } = await import('../src/lib/server/db.js');

test('manual additions are persistent catalogue films and always sort after ranked films', () => {
  const record = normaliseTmdbMovie(movie);
  const added = addManualFilm('viewer@example.com', record);
  assert.deepEqual(added, { id: -1184918, created: true });
  assert.deepEqual(addManualFilm('viewer@example.com', record), { id: -1184918, created: false });

  const result = queryFilms({ sort: 'title', order: 'asc', user: 'viewer@example.com' });
  assert.equal(result.total, 2);
  assert.equal(result.items[0].title, 'Zulu');
  assert.equal(result.items[1].title, 'The Wild Robot');
  assert.equal(result.items[1].manually_added, 1);
  assert.equal(result.items[1].rank, null);

  const detail = getFilm(-1184918, 'viewer@example.com');
  assert.equal(detail.tmdb_id, 1184918);
  assert.equal(detail.manually_added, 1);
  assert.equal(detail.history.length, 0);
});
