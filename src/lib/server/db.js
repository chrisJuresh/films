// Server-only data layer. Reads the tspdt.db built by sync/tspdt_sync.py via
// the built-in node:sqlite module -- no native dependency to compile.
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { displayTitle } from '../util.js';
import { filmMinAge } from './certAge.mjs';

// Find tspdt.db whether launched from the repo root or elsewhere (dev/build/preview differ).
const here = dirname(fileURLToPath(import.meta.url));

// The connection is opened LAZILY on first query, not at module load. That lets
// this module be imported without a database present -- notably during
// `vite build`, whose analyse step imports every server module to read its
// exports. (Opening at import time would make the build require a prebuilt DB.)
let _db = null;
function getDb() {
  if (_db) return _db;
  const CANDIDATES = [
    process.env.TSPDT_DB,
    resolve(process.cwd(), 'tspdt.db'),
    resolve(process.cwd(), 'sync', 'tspdt.db'),
    resolve(here, '../../../tspdt.db'),      // src/lib/server -> repo root
    resolve(here, '../../../sync/tspdt.db')  // repo root/sync
  ].filter(Boolean);
  const DB_PATH = CANDIDATES.find((p) => existsSync(p));
  if (!DB_PATH) {
    throw new Error(
      'tspdt.db not found. Run  python tspdt_sync.py  in the project root first. Looked in:\n  ' +
      CANDIDATES.join('\n  ')
    );
  }
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 4000;');
  // Personal state + metadata caches -- added alongside the synced data; the
  // Python sync never touches these tables.
  //   * user_status is PER USER: the film's status ON THIS SITE (watchlist XOR
  //     seen), keyed on (cf_user, id_tspdt) per Cloudflare Access identity.
  //   * lb_seen is the SEPARATE Letterboxd "watched" tracker, PER USER. state is
  //     'watched' (imported) or 'unwatched' (was imported, then un-ticked here --
  //     we keep the row as a record). A film counts as seen if it's site-seen OR
  //     lb_seen='watched'. Import only ever ADDS; it never flips a row back.
  //   * film_cert is a film property (age ratings, all countries), shared across
  //     users -- queryable so the catalogue can be filtered by rating.
  //   * film_meta is a film property (poster art, ratings), shared across users.
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_status (
      cf_user    TEXT NOT NULL,
      id_tspdt   INTEGER NOT NULL REFERENCES films(id_tspdt) ON DELETE CASCADE,
      status     TEXT NOT NULL CHECK(status IN ('watchlist','seen','rewatch','unfinished')),
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (cf_user, id_tspdt)
    );
    CREATE TABLE IF NOT EXISTS lb_seen (
      cf_user     TEXT NOT NULL,
      id_tspdt    INTEGER NOT NULL REFERENCES films(id_tspdt) ON DELETE CASCADE,
      state       TEXT NOT NULL CHECK(state IN ('watched','unwatched')),
      lb_date     TEXT,
      imported_at TEXT DEFAULT (datetime('now')),
      updated_at  TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (cf_user, id_tspdt)
    );
    CREATE TABLE IF NOT EXISTS film_cert (
      id_tspdt   INTEGER NOT NULL REFERENCES films(id_tspdt) ON DELETE CASCADE,
      country    TEXT NOT NULL,
      cert       TEXT NOT NULL,
      PRIMARY KEY (id_tspdt, country, cert)
    );
    CREATE INDEX IF NOT EXISTS film_cert_cert ON film_cert(cert);
    CREATE TABLE IF NOT EXISTS film_age (
      id_tspdt INTEGER PRIMARY KEY REFERENCES films(id_tspdt) ON DELETE CASCADE,
      min_age  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS film_age_age ON film_age(min_age);
    CREATE TABLE IF NOT EXISTS film_meta (
      id_tspdt      INTEGER PRIMARY KEY REFERENCES films(id_tspdt) ON DELETE CASCADE,
      level         TEXT,
      json          TEXT NOT NULL,
      fetched_at    TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS playback (
      cf_user    TEXT NOT NULL,
      id_tspdt   INTEGER NOT NULL REFERENCES films(id_tspdt) ON DELETE CASCADE,
      position   REAL NOT NULL,
      duration   REAL,
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (cf_user, id_tspdt)
    );
    CREATE TABLE IF NOT EXISTS film_download (
      id_tspdt INTEGER PRIMARY KEY REFERENCES films(id_tspdt) ON DELETE CASCADE,
      state    TEXT NOT NULL,            -- downloaded | downloading | wanted | error
      progress INTEGER                   -- 0-100 while downloading, else null
    );
    CREATE INDEX IF NOT EXISTS film_download_state ON film_download(state);
    CREATE TABLE IF NOT EXISTS lb_unmatched (
      cf_user     TEXT NOT NULL,
      name        TEXT NOT NULL,
      year        TEXT NOT NULL DEFAULT '',   -- '' when the CSV had no year
      lb_date     TEXT,
      imported_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (cf_user, name, year)
    );
    CREATE TABLE IF NOT EXISTS manual_films (
      tmdb_id     INTEGER PRIMARY KEY,
      id_tspdt    INTEGER NOT NULL UNIQUE,
      imdb_id     TEXT,
      title       TEXT NOT NULL,
      year        TEXT,
      added_by    TEXT,
      added_at    TEXT NOT NULL DEFAULT (datetime('now')),
      merged_into INTEGER,
      merged_at   TEXT
    );
    CREATE INDEX IF NOT EXISTS manual_films_active ON manual_films(id_tspdt) WHERE merged_into IS NULL;
    CREATE INDEX IF NOT EXISTS manual_films_imdb ON manual_films(imdb_id) WHERE imdb_id IS NOT NULL;
  `);
  // Manual additions store their TMDB identity on the film row as well as in
  // manual_films. The latter is the durable audit trail; the former keeps
  // duplicate checks and integrations cheap. Existing databases gain it here.
  const filmCols = new Set(db.prepare('PRAGMA table_info(films)').all().map((c) => c.name));
  if (!filmCols.has('tmdb_id')) db.exec('ALTER TABLE films ADD COLUMN tmdb_id INTEGER');
  db.exec('CREATE INDEX IF NOT EXISTS idx_films_tmdb ON films(tmdb_id) WHERE tmdb_id IS NOT NULL');
  // Backfill TMDB ids already learned by the enrichment cache. JSON1 ships
  // with the Node SQLite build, but keep startup tolerant of an unusual build.
  try {
    db.exec(`UPDATE films SET tmdb_id=CAST(json_extract(
      (SELECT json FROM film_meta WHERE film_meta.id_tspdt=films.id_tspdt), '$.tmdb_id'
    ) AS INTEGER)
    WHERE tmdb_id IS NULL AND EXISTS (
      SELECT 1 FROM film_meta WHERE film_meta.id_tspdt=films.id_tspdt
        AND json_valid(film_meta.json) AND json_extract(film_meta.json, '$.tmdb_id') IS NOT NULL
    )`);
  } catch { /* JSON1 unavailable: duplicate checks still fall back to IMDb. */ }
  // Migration for DBs created before film_download had a progress column.
  try { db.exec('ALTER TABLE film_download ADD COLUMN progress INTEGER'); } catch { /* already present */ }
  // Migration: older DBs created user_status with CHECK IN ('watchlist','seen').
  // Rebuild it (preserving every row) so 'rewatch' / 'unfinished' are allowed.
  const usSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='user_status'").get()?.sql || '';
  if (!usSql.includes('rewatch')) {
    // Atomic: if interrupted (e.g. a lock timeout), the whole rebuild rolls back
    // and re-runs next open — the existing watchlist/seen rows are never stranded.
    db.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE user_status RENAME TO _user_status_old;
      CREATE TABLE user_status (
        cf_user    TEXT NOT NULL,
        id_tspdt   INTEGER NOT NULL REFERENCES films(id_tspdt) ON DELETE CASCADE,
        status     TEXT NOT NULL CHECK(status IN ('watchlist','seen','rewatch','unfinished')),
        updated_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (cf_user, id_tspdt)
      );
      INSERT INTO user_status SELECT * FROM _user_status_old;
      DROP TABLE _user_status_old;
      COMMIT;
    `);
  }
  // One-time: derive film_age from the already-downloaded film_cert data (no
  // network). Runs once — when certs exist but no ages have been computed yet.
  const cov = db.prepare('SELECT (SELECT count(*) FROM film_cert) certs, (SELECT count(*) FROM film_age) ages').get();
  if (cov.certs > 0 && cov.ages === 0) recomputeFilmAges(db);
  _db = db;
  return _db;
}

// Rebuild film_age from film_cert using the shared cert→age mapping. Pure
// compute (no network), safe to re-run; used for the one-time bulk derivation.
function recomputeFilmAges(db) {
  const rows = db.prepare('SELECT id_tspdt, country, cert FROM film_cert ORDER BY id_tspdt').all();
  const ins = db.prepare('INSERT INTO film_age(id_tspdt, min_age) VALUES(?,?) ON CONFLICT(id_tspdt) DO UPDATE SET min_age=excluded.min_age');
  db.exec('BEGIN');
  try {
    let cur = null, certs = [];
    const flush = () => { if (cur != null) { const a = filmMinAge(certs); if (a != null) ins.run(cur, a); } };
    for (const r of rows) {
      if (r.id_tspdt !== cur) { flush(); cur = r.id_tspdt; certs = []; }
      certs.push({ country: r.country, cert: r.cert });
    }
    flush();
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/* -------------------------------------------------------------- facets ---- */
let _facets = null;
export function getFacets() {
  if (_facets) return _facets;
  const db = getDb();
  const rows = db.prepare(
    `SELECT f.country, f.genre, f.colour, f.year
     FROM films f
     LEFT JOIN manual_films mf ON mf.id_tspdt=f.id_tspdt AND mf.merged_into IS NULL
     WHERE f.removed_at IS NULL AND (f.latest_rank IS NOT NULL OR mf.id_tspdt IS NOT NULL)`
  ).all();
  const countries = new Map(), genres = new Map(), colours = new Map(), decades = new Map();
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  for (const r of rows) {
    for (const t of String(r.country || '').split('-')) { const s = t.trim(); if (s && s !== '---') bump(countries, s); }
    for (const t of String(r.genre || '').split('-')) { const s = t.trim(); if (s && s !== '---') bump(genres, s); }
    const c = String(r.colour || '').trim(); if (c && c !== '---') bump(colours, c);
    if (/^\d{4}$/.test(r.year || '')) bump(decades, (Math.floor(+r.year / 10) * 10));
  }
  const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(b[0]))
    .slice(0, n).map(([value, count]) => ({ value, count }));
  const catalogue = `f.removed_at IS NULL AND (f.latest_rank IS NOT NULL OR EXISTS (
    SELECT 1 FROM manual_films mf WHERE mf.id_tspdt=f.id_tspdt AND mf.merged_into IS NULL
  ))`;
  const total = db.prepare(`SELECT count(*) c FROM films f WHERE ${catalogue}`).get().c;
  const latest = db.prepare('SELECT label, poll_year FROM editions ORDER BY poll_date DESC, edition_id DESC LIMIT 1').get();
  // Age ratings: distinct certifications across all countries (film_cert is
  // backfilled + kept fresh on enrichment). Mixed systems (R / 15 / 18 / U …).
  const certifications = db.prepare(
    `SELECT fc.cert AS value, count(DISTINCT fc.id_tspdt) AS count
     FROM film_cert fc JOIN films f USING(id_tspdt)
     WHERE ${catalogue}
     GROUP BY fc.cert ORDER BY count DESC, value LIMIT 80`
  ).all();
  // Age-rating distribution (min admittance age -> film count) for the slider.
  const ages = db.prepare(
    `SELECT fa.min_age AS age, count(*) AS count
     FROM film_age fa JOIN films f USING(id_tspdt)
     WHERE ${catalogue}
     GROUP BY fa.min_age ORDER BY fa.min_age`
  ).all();
  _facets = {
    total,
    latestEdition: latest?.label ?? null,
    latestPollYear: latest?.poll_year ?? null,
    countries: top(countries, 80),
    genres: top(genres, 60),
    colours: top(colours, 6),
    decades: [...decades.entries()].sort((a, b) => a[0] - b[0]).map(([value, count]) => ({ value, count })),
    certifications,
    ages
  };
  return _facets;
}

/* -------------------------------------------------------------- films ----- */
const SORTS = { rank: 'f.latest_rank', year: "CAST(f.year AS INT)", title: 'f.title' };

const MAX_VALUES = 40;                                              // cap multi-select values -> bounded SQL
const multi = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, MAX_VALUES);
const likeEsc = (s) => String(s).replace(/[\\%_]/g, '\\$&');       // escape LIKE metachars (%, _, \)
const LIKE = "LIKE ? ESCAPE '\\'";

export function queryFilms(p = {}) {
  const db = getDb();
  const user = p.user ?? 'local';                                  // per-user watchlist/seen (Cloudflare identity)
  const where = ['f.removed_at IS NULL', '(f.latest_rank IS NOT NULL OR mf.id_tspdt IS NOT NULL)'];
  const args = [];
  if (p.q) { where.push(`(f.title ${LIKE} OR f.director ${LIKE})`); args.push(`%${likeEsc(p.q)}%`, `%${likeEsc(p.q)}%`); }

  const decades = multi(p.decade).filter((d) => /^\d{4}$/.test(d));   // multi-select facets: OR within, AND across
  if (decades.length) {
    where.push('(' + decades.map(() => "(f.year GLOB '[0-9][0-9][0-9][0-9]' AND CAST(f.year AS INT) BETWEEN ? AND ?)").join(' OR ') + ')');
    decades.forEach((d) => args.push(+d, +d + 9));
  }
  const genres = multi(p.genre);
  if (genres.length) { where.push('(' + genres.map(() => `f.genre ${LIKE}`).join(' OR ') + ')'); genres.forEach((g) => args.push(`%${likeEsc(g)}%`)); }
  const countries = multi(p.country);
  if (countries.length) { where.push('(' + countries.map(() => `f.country ${LIKE}`).join(' OR ') + ')'); countries.forEach((c) => args.push(`%${likeEsc(c)}%`)); }
  const colours = multi(p.colour);
  if (colours.length) { where.push('f.colour IN (' + colours.map(() => '?').join(',') + ')'); colours.forEach((c) => args.push(c)); }
  if (p.new === '1' || p.new === true) where.push('f.is_new = 1');
  const certs = multi(p.cert);   // (legacy) match if the film has ANY selected raw cert
  if (certs.length) {
    where.push('EXISTS (SELECT 1 FROM film_cert fc WHERE fc.id_tspdt = f.id_tspdt AND fc.cert IN ('
      + certs.map(() => '?').join(',') + '))');
    certs.forEach((c) => args.push(c));
  }
  // Age slider: show films suitable for viewers up to `maxage`. A film's age is
  // its most-restrictive rating, so nothing unsuitable slips into a younger
  // bracket. At/above 18 the slider is off (everything, incl. unrated, shows).
  const maxage = (p.maxage === '' || p.maxage == null) ? null : Math.trunc(+p.maxage);
  if (maxage != null && !Number.isNaN(maxage) && maxage < 18) {
    where.push('EXISTS (SELECT 1 FROM film_age fa WHERE fa.id_tspdt = f.id_tspdt AND fa.min_age <= ?)');
    args.push(maxage);
  }
  if (['downloaded', 'downloading', 'wanted', 'error'].includes(p.radarr)) {   // Radarr download-state filter
    where.push('EXISTS (SELECT 1 FROM film_download fd WHERE fd.id_tspdt = f.id_tspdt AND fd.state = ?)');
    args.push(p.radarr);
  }

  // Per-user joins: site status (us) + Letterboxd watched state (lb) for THIS user.
  // film_download (fd) is global (Radarr's view), not per-user.
  const joins = `LEFT JOIN manual_films mf ON mf.id_tspdt = f.id_tspdt AND mf.merged_into IS NULL
     LEFT JOIN user_status us ON us.id_tspdt = f.id_tspdt AND us.cf_user = ?
     LEFT JOIN lb_seen lb ON lb.id_tspdt = f.id_tspdt AND lb.cf_user = ?
     LEFT JOIN film_download fd ON fd.id_tspdt = f.id_tspdt
     LEFT JOIN playback pb ON pb.id_tspdt = f.id_tspdt AND pb.cf_user = ?`;
  const joinArgs = [user, user, user];
  // "seen" spans both trackers; "watchlist" is site-only.
  if (p.status === 'watchlist') where.push("us.status = 'watchlist'");
  else if (p.status === 'seen') where.push("(us.status = 'seen' OR lb.state = 'watched')");
  else if (p.status === 'rewatch') where.push("us.status = 'rewatch'");
  else if (p.status === 'unfinished') where.push("us.status = 'unfinished'");

  const sort = Object.hasOwn(SORTS, p.sort) ? SORTS[p.sort] : SORTS.rank;  // no prototype read-through
  const order = p.order === 'desc' ? 'DESC' : 'ASC';
  const limit = Math.trunc(Math.max(1, Math.min(120, +p.limit || 60)));   // integer for LIMIT/OFFSET
  const offset = Math.max(0, Math.trunc(+p.offset || 0));
  const wc = where.join(' AND ');
  // Manual additions are deliberately a coda to the ranked catalogue for every
  // sort mode. Within that coda, the selected sort still applies, with added_at
  // providing a deterministic final order for infinite-scroll offsets.
  const manualLast = 'CASE WHEN mf.id_tspdt IS NULL THEN 0 ELSE 1 END ASC';

  // The joins' `?` (user, user) bind before the WHERE args; LIMIT/OFFSET bind last.
  const total = db.prepare(`SELECT count(*) c FROM films f ${joins} WHERE ${wc}`).get(...joinArgs, ...args).c;
  const items = db.prepare(
    `SELECT f.id_tspdt, f.latest_rank AS rank, f.title, f.year, f.director, f.country,
            f.genre, f.length_min, f.colour, f.imdb_id, f.imdb_url, f.tmdb_id, f.is_new,
            CASE WHEN mf.id_tspdt IS NULL THEN 0 ELSE 1 END AS manually_added,
            us.status, lb.state AS lb_state, fd.state AS download, fd.progress AS download_progress,
            pb.position AS pb_position, pb.duration AS pb_duration
     FROM films f ${joins} WHERE ${wc}
     ORDER BY ${manualLast}, ${sort} ${order}, f.latest_rank ASC, mf.added_at ASC, f.id_tspdt ASC
     LIMIT ? OFFSET ?`
  ).all(...joinArgs, ...args, limit, offset);
  return { total, items };
}

function resolveFilmId(db, id) {
  const n = Number(id);
  if (!Number.isSafeInteger(n)) return null;
  if (db.prepare('SELECT 1 FROM films WHERE id_tspdt=?').get(n)) return n;
  return db.prepare(
    'SELECT merged_into FROM manual_films WHERE id_tspdt=? AND merged_into IS NOT NULL'
  ).get(n)?.merged_into ?? null;
}

// Basic rows for a set of ids (order not guaranteed). Used by the download
// tracker to resolve titles/posters for locally-saved films (desktop app),
// which aren't necessarily in any Radarr download state.
export function filmsByIds(ids) {
  const arr = [...new Set((ids || []).map(Number).filter(Number.isInteger))].slice(0, 300);
  if (!arr.length) return [];
  const db = getDb();
  const get = db.prepare(
    `SELECT f.id_tspdt, f.latest_rank AS rank, f.title, f.year, f.director, f.imdb_id,
            CASE WHEN mf.id_tspdt IS NULL THEN 0 ELSE 1 END AS manually_added
     FROM films f
     LEFT JOIN manual_films mf ON mf.id_tspdt=f.id_tspdt AND mf.merged_into IS NULL
     WHERE f.id_tspdt=?`
  );
  const rows = [];
  for (const requested of arr) {
    const actual = resolveFilmId(db, requested);
    const row = actual == null ? null : get.get(actual);
    // Desktop downloads keep the id used when the file was saved. Returning
    // that requested id preserves the local-file lookup after reconciliation;
    // /film/:id and /api/meta/:id resolve the durable alias transparently.
    if (row) rows.push({ ...row, id_tspdt: requested, canonical_id: actual });
  }
  return rows;
}

export function getFilmBasic(id) {
  const db = getDb();
  const actual = resolveFilmId(db, id);
  if (actual == null) return null;
  return db.prepare(
    'SELECT id_tspdt, imdb_id, imdb_url, tmdb_id, title, year FROM films WHERE id_tspdt = ?'
  ).get(actual) || null;
}

export function getFilm(id, user = 'local') {
  const db = getDb();
  const actual = resolveFilmId(db, id);
  if (actual == null) return null;
  const row = db.prepare(
    `SELECT f.*, us.status, lb.state AS lb_state, fd.state AS download, fd.progress AS download_progress,
            CASE WHEN mf.id_tspdt IS NULL THEN 0 ELSE 1 END AS manually_added,
            mf.added_at AS manually_added_at
     FROM films f
     LEFT JOIN manual_films mf ON mf.id_tspdt = f.id_tspdt AND mf.merged_into IS NULL
     LEFT JOIN user_status us ON us.id_tspdt = f.id_tspdt AND us.cf_user = ?
     LEFT JOIN lb_seen lb ON lb.id_tspdt = f.id_tspdt AND lb.cf_user = ?
     LEFT JOIN film_download fd ON fd.id_tspdt = f.id_tspdt
     WHERE f.id_tspdt = ?`
  ).get(user, user, actual);
  if (!row) return null;
  delete row.content_hash;
  row.history = db.prepare(
    `SELECT e.label, e.poll_year, r.position FROM rankings r
     JOIN editions e USING(edition_id) WHERE r.id_tspdt = ?
     ORDER BY e.poll_date ASC, e.edition_id ASC`
  ).all(actual);
  row.certs = db.prepare('SELECT country, cert FROM film_cert WHERE id_tspdt = ? ORDER BY country, cert').all(actual);
  row.playback = db.prepare('SELECT position, duration FROM playback WHERE cf_user=? AND id_tspdt=?').get(user, actual) || null;
  return row;
}

/* --------------------------------------------------- manual additions ---- */
function existingFilm(db, tmdbId, imdbId = null) {
  // manual_films survives reconciliation, so a TMDB result remains recognised
  // after its temporary negative id has been merged into a real TSPDT id.
  const tracked = db.prepare(
    `SELECT COALESCE(merged_into, id_tspdt) AS id_tspdt
     FROM manual_films WHERE tmdb_id=?`
  ).get(tmdbId);
  if (tracked && db.prepare('SELECT 1 FROM films WHERE id_tspdt=?').get(tracked.id_tspdt)) return tracked.id_tspdt;

  const clauses = ['f.tmdb_id=?'];
  const args = [tmdbId];
  if (imdbId) { clauses.push('f.imdb_id=?'); args.push(imdbId); }
  return db.prepare(
    `SELECT f.id_tspdt
     FROM films f
     LEFT JOIN manual_films mf ON mf.id_tspdt=f.id_tspdt AND mf.merged_into IS NULL
     WHERE f.removed_at IS NULL AND (f.latest_rank IS NOT NULL OR mf.id_tspdt IS NOT NULL)
       AND (${clauses.join(' OR ')})
     ORDER BY (f.latest_rank IS NULL), f.latest_rank
     LIMIT 1`
  ).get(...args)?.id_tspdt ?? null;
}

// Resolve search results to catalogue ids in one bounded query. Returned keys
// are TMDB ids and values are the film routes the UI should treat as existing.
export function existingFilmsByTmdb(tmdbIds) {
  const ids = [...new Set((tmdbIds || []).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))].slice(0, 20);
  if (!ids.length) return {};
  const db = getDb();
  const out = {};
  for (const id of ids) {
    const filmId = existingFilm(db, id);
    if (filmId != null) out[id] = filmId;
  }
  return out;
}

// `record` is the normalised result of a TMDB details lookup. The negative id
// namespace cannot collide with TSPDT's positive natural ids, while tmdb_id is
// the stable external identity used for deduplication and future reconciliation.
export function addManualFilm(user, record) {
  const db = getDb();
  const tmdbId = Number(record?.tmdbId);
  if (!Number.isSafeInteger(tmdbId) || tmdbId <= 0) throw new TypeError('A valid TMDB id is required.');
  const imdbId = /^tt\d+$/.test(record?.film?.imdb_id || '') ? record.film.imdb_id : null;
  const already = existingFilm(db, tmdbId, imdbId);
  if (already != null) return { id: already, created: false };

  const id = -tmdbId;
  const film = record.film || {};
  const now = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    const raced = existingFilm(db, tmdbId, imdbId);
    if (raced != null) { db.exec('COMMIT'); return { id: raced, created: false }; }
    if (db.prepare('SELECT 1 FROM films WHERE id_tspdt=?').get(id)) {
      throw new Error('The manual film id is already in use.');
    }
    db.prepare(
      `INSERT INTO films (
         id_tspdt, imdb_id, imdb_url, tmdb_id, is_new, director, title, year, country,
         length_min, colour, genre, latest_rank, latest_edition_id, content_hash,
         first_seen, last_seen, removed_at
       ) VALUES (?,?,?,?,0,?,?,?,?,?,?,?,NULL,NULL,?,?,?,NULL)`
    ).run(
      id, imdbId, film.imdb_url || null, tmdbId, film.director || null,
      film.title, film.year || null, film.country || null, film.length_min || null,
      film.colour || null, film.genre || null, `manual:tmdb:${tmdbId}`, now, now
    );
    db.prepare(
      `INSERT INTO manual_films(tmdb_id,id_tspdt,imdb_id,title,year,added_by,added_at)
       VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(tmdb_id) DO UPDATE SET
         id_tspdt=excluded.id_tspdt, imdb_id=excluded.imdb_id, title=excluded.title,
         year=excluded.year, added_by=excluded.added_by, added_at=excluded.added_at,
         merged_into=NULL, merged_at=NULL`
    ).run(tmdbId, id, imdbId, film.title, film.year || null, user || 'local', now);

    const meta = { ...(record.meta || {}), id_tspdt: id, tmdb_id: tmdbId };
    if (meta.poster_src) meta.poster = `/img/poster/${id}`;
    if (meta.backdrop_src) meta.backdrop = `/img/backdrop/${id}`;
    db.prepare('INSERT INTO film_meta(id_tspdt,level,json,fetched_at) VALUES(?,?,?,datetime(\'now\'))')
      .run(id, 'full', JSON.stringify(meta));

    const certs = [];
    const insCert = db.prepare('INSERT OR IGNORE INTO film_cert(id_tspdt,country,cert) VALUES(?,?,?)');
    for (const c of record.certs || []) {
      const country = String(c?.country || '').trim();
      const cert = String(c?.cert || '').trim();
      if (cert) { insCert.run(id, country, cert); certs.push({ country, cert }); }
    }
    const age = filmMinAge(certs);
    if (age != null) db.prepare('INSERT INTO film_age(id_tspdt,min_age) VALUES(?,?)').run(id, age);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  _facets = null;
  _titleIndex = null;
  return { id, created: true };
}

/* -------------------------------------------------------------- status ---- */
// Site status is a single value per film (watchlist XOR seen). Letterboxd
// "watched" is tracked SEPARATELY in lb_seen, so a film is SEEN if it's
// site-seen OR lb_seen='watched'.
function statusFor(db, user, id) {
  id = resolveFilmId(db, id) ?? id;
  const site = db.prepare('SELECT status FROM user_status WHERE cf_user=? AND id_tspdt=?').get(user, id)?.status ?? null;
  const lb_state = db.prepare('SELECT state FROM lb_seen WHERE cf_user=? AND id_tspdt=?').get(user, id)?.state ?? null;
  return {
    status: site, lb_state,
    watchlist: site === 'watchlist',
    site_seen: site === 'seen',
    rewatch: site === 'rewatch',
    unfinished: site === 'unfinished',
    lb_watched: lb_state === 'watched',
    seen: site === 'seen' || lb_state === 'watched',
    counts: counts(user)
  };
}

// One site status per film (watchlist / seen / rewatch / unfinished), mutually
// exclusive. kind is one of those; on = boolean.
const SITE_STATUSES = new Set(['watchlist', 'seen', 'rewatch', 'unfinished']);
export function setStatus(user, id, kind, on) {
  const db = getDb();
  id = resolveFilmId(db, id) ?? id;
  if (!SITE_STATUSES.has(kind)) return statusFor(db, user, id);
  if (on) {
    db.prepare(
      `INSERT INTO user_status(cf_user, id_tspdt, status, updated_at) VALUES(?,?,?,datetime('now'))
       ON CONFLICT(cf_user, id_tspdt) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at`
    ).run(user, id, kind);
  } else {
    db.prepare("DELETE FROM user_status WHERE cf_user=? AND id_tspdt=? AND status=?").run(user, id, kind);
    // Un-ticking "seen" also retires a Letterboxd import: keep the lb_seen row
    // but mark it 'unwatched' (a record it was imported, then removed here).
    if (kind === 'seen') {
      db.prepare("UPDATE lb_seen SET state='unwatched', updated_at=datetime('now') WHERE cf_user=? AND id_tspdt=? AND state='watched'").run(user, id);
    }
  }
  return statusFor(db, user, id);
}

export function counts(user = 'local') {
  const db = getDb();
  const s = db.prepare(
    `SELECT COALESCE(SUM(status='watchlist'),0) watchlist,
            COALESCE(SUM(status='rewatch'),0)   rewatch,
            COALESCE(SUM(status='unfinished'),0) unfinished
     FROM user_status WHERE cf_user=?`
  ).get(user);
  const seen = db.prepare(
    `SELECT count(*) c FROM (
       SELECT id_tspdt FROM user_status WHERE cf_user=? AND status='seen'
       UNION
       SELECT id_tspdt FROM lb_seen WHERE cf_user=? AND state='watched'
     )`
  ).get(user, user).c;
  return { watchlist: s.watchlist, seen, rewatch: s.rewatch, unfinished: s.unfinished };
}

/* ------------------------------------------------- enrichment cache ------ */
export function getMetaCache(id) {
  const db = getDb();
  id = resolveFilmId(db, id) ?? id;
  return db.prepare('SELECT json, level, fetched_at FROM film_meta WHERE id_tspdt = ?').get(id) || null;
}
export function setMetaCache(id, obj, level) {
  const db = getDb();
  id = resolveFilmId(db, id) ?? id;
  db.prepare(
    `INSERT INTO film_meta(id_tspdt, level, json, fetched_at) VALUES(?,?,?,datetime('now'))
     ON CONFLICT(id_tspdt) DO UPDATE SET level=excluded.level, json=excluded.json, fetched_at=excluded.fetched_at`
  ).run(id, level, JSON.stringify(obj));
  if (Number.isSafeInteger(obj?.tmdb_id) && obj.tmdb_id > 0) {
    db.prepare('UPDATE films SET tmdb_id=COALESCE(tmdb_id,?) WHERE id_tspdt=?').run(obj.tmdb_id, id);
  }
}

/* -------------------------------------------------- playback position ---- */
export function setPlayback(user, id, position, duration) {
  const db = getDb();
  id = resolveFilmId(db, id) ?? id;
  db.prepare(
    `INSERT INTO playback(cf_user, id_tspdt, position, duration, updated_at) VALUES(?,?,?,?,datetime('now'))
     ON CONFLICT(cf_user, id_tspdt) DO UPDATE SET position=excluded.position, duration=excluded.duration, updated_at=excluded.updated_at`
  ).run(user, id, position, duration ?? null);
}
export function getPlayback(user, id) {
  const db = getDb();
  id = resolveFilmId(db, id) ?? id;
  return db.prepare('SELECT position, duration FROM playback WHERE cf_user=? AND id_tspdt=?').get(user, id) || null;
}
export function clearPlayback(user, id) {
  const db = getDb();
  id = resolveFilmId(db, id) ?? id;
  db.prepare('DELETE FROM playback WHERE cf_user=? AND id_tspdt=?').run(user, id);
}

/* ---------------------------------------------- Radarr download state ---- */
// Replace film_download with a fresh snapshot mapping our films to Radarr's
// download state. stateByImdb: iterable of [imdbId, { state, progress }].
export function syncFilmDownloads(stateByImdb) {
  const db = getDb();
  const sel = db.prepare(
    `SELECT f.id_tspdt FROM films f
     LEFT JOIN manual_films mf ON mf.id_tspdt=f.id_tspdt AND mf.merged_into IS NULL
     WHERE f.imdb_id=? AND f.removed_at IS NULL AND (f.latest_rank IS NOT NULL OR mf.id_tspdt IS NOT NULL)
     ORDER BY (f.latest_rank IS NULL), f.latest_rank LIMIT 1`
  );
  const rows = [];
  for (const [imdb, v] of stateByImdb) {
    const r = imdb && sel.get(imdb);
    if (r) rows.push([r.id_tspdt, v?.state ?? v, v?.progress ?? null]);   // tolerate a bare state string
  }
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM film_download');
    const ins = db.prepare('INSERT OR REPLACE INTO film_download(id_tspdt, state, progress) VALUES(?,?,?)');
    for (const [id, st, pct] of rows) ins.run(id, st, pct);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
export function downloadCounts() {
  const out = { downloaded: 0, downloading: 0, wanted: 0, error: 0 };
  for (const r of getDb().prepare('SELECT state, count(*) c FROM film_download GROUP BY state').all())
    if (r.state in out) out[r.state] = r.c;
  return out;
}

/* ------------------------------------------------- age-rating certs ------ */
// Replace all stored certifications for a film. certs = [{ country, cert }].
export function setFilmCerts(id, certs) {
  const db = getDb();
  id = resolveFilmId(db, id) ?? id;
  db.prepare('DELETE FROM film_cert WHERE id_tspdt = ?').run(id);
  const ins = db.prepare('INSERT OR IGNORE INTO film_cert(id_tspdt, country, cert) VALUES(?,?,?)');
  const clean = [];
  for (const c of certs || []) {
    const cert = String(c?.cert ?? '').trim();
    const country = String(c?.country ?? '').trim();
    if (cert) { ins.run(id, country, cert); clean.push({ country, cert }); }
  }
  const age = filmMinAge(clean);
  if (age == null) db.prepare('DELETE FROM film_age WHERE id_tspdt=?').run(id);
  else db.prepare('INSERT INTO film_age(id_tspdt, min_age) VALUES(?,?) ON CONFLICT(id_tspdt) DO UPDATE SET min_age=excluded.min_age').run(id, age);
}

/* --------------------------------------------------- letterboxd import --- */
// Match a letterboxd title to a catalogue film. Letterboxd stores natural order
// ("The Rules of the Game"); TSPDT stores article-suffix ("Rules of the Game,
// The"). displayTitle() normalises TSPDT into natural order, so canonicalising
// both to lowercase alphanumerics lets them meet in the middle.
const canon = (t) => displayTitle(t).toLowerCase().normalize('NFKD')
  .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');

let _titleIndex = null;
function titleIndex(db) {
  if (_titleIndex) return _titleIndex;
  const m = new Map();
  for (const r of db.prepare(
    `SELECT f.id_tspdt, f.title, f.year FROM films f
     LEFT JOIN manual_films mf ON mf.id_tspdt=f.id_tspdt AND mf.merged_into IS NULL
     WHERE f.removed_at IS NULL AND (f.latest_rank IS NOT NULL OR mf.id_tspdt IS NOT NULL)`
  ).all()) {
    const k = canon(r.title);
    if (!k) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push({ id: r.id_tspdt, year: parseInt(r.year, 10) });
  }
  _titleIndex = m;
  return m;
}
function matchFilm(idx, name, year) {
  const cands = idx.get(canon(name));
  if (!cands || !cands.length) return null;
  const y = parseInt(year, 10);
  if (Number.isNaN(y)) return cands[0].id;
  const hit = cands.find((c) => c.year === y) || cands.find((c) => Math.abs(c.year - y) <= 1) || (cands.length === 1 ? cands[0] : null);
  return hit?.id ?? null;
}

// rows = [{ date, name, year }] parsed from a letterboxd watched.csv.
// Only ever ADDS: an existing lb_seen row (watched OR unwatched) is left as-is,
// so a manual un-tick is never resurrected by a re-import.
export function importLetterboxd(user, rows) {
  const db = getDb();
  const idx = titleIndex(db);
  const has = db.prepare('SELECT state FROM lb_seen WHERE cf_user=? AND id_tspdt=?');
  const ins = db.prepare(
    `INSERT INTO lb_seen(cf_user, id_tspdt, state, lb_date, imported_at, updated_at)
     VALUES(?,?,'watched',?,datetime('now'),datetime('now'))`
  );
  // Persist rows that matched nothing so the reconciliation page can always show
  // them; a row that matches on a later import is dropped from this list.
  const insU = db.prepare(
    `INSERT INTO lb_unmatched(cf_user, name, year, lb_date, imported_at)
     VALUES(?,?,?,?,datetime('now'))
     ON CONFLICT(cf_user, name, year) DO UPDATE SET lb_date=excluded.lb_date`
  );
  const delU = db.prepare('DELETE FROM lb_unmatched WHERE cf_user=? AND name=? AND year=?');
  let matched = 0, added = 0, already = 0; const unmatched = [];
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const yr = String(r.year || '');
      const id = matchFilm(idx, r.name, r.year);
      if (!id) { insU.run(user, r.name, yr, r.date || null); unmatched.push({ name: r.name, year: r.year }); continue; }
      delU.run(user, r.name, yr);   // it matches now — no longer "not found"
      matched++;
      if (has.get(user, id)) { already++; continue; }
      ins.run(user, id, r.date || null);
      added++;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { total: rows.length, matched, added, already, unmatched, counts: counts(user) };
}

// The two lists shown on the /letterboxd reconciliation page.
export function reconciliation(user) {
  const db = getDb();
  const onlySite = db.prepare(
    `SELECT f.id_tspdt, f.latest_rank AS rank, f.title, f.year, f.director,
            CASE WHEN mf.id_tspdt IS NULL THEN 0 ELSE 1 END AS manually_added
     FROM user_status us JOIN films f USING(id_tspdt)
     LEFT JOIN manual_films mf ON mf.id_tspdt=f.id_tspdt AND mf.merged_into IS NULL
     LEFT JOIN lb_seen lb ON lb.id_tspdt = f.id_tspdt AND lb.cf_user = ?
     WHERE us.cf_user = ? AND us.status = 'seen' AND lb.id_tspdt IS NULL
     ORDER BY (mf.id_tspdt IS NOT NULL), f.latest_rank, mf.added_at`
  ).all(user, user);
  const lbRemoved = db.prepare(
    `SELECT f.id_tspdt, f.latest_rank AS rank, f.title, f.year, f.director, lb.lb_date,
            CASE WHEN mf.id_tspdt IS NULL THEN 0 ELSE 1 END AS manually_added
     FROM lb_seen lb JOIN films f USING(id_tspdt)
     LEFT JOIN manual_films mf ON mf.id_tspdt=f.id_tspdt AND mf.merged_into IS NULL
     WHERE lb.cf_user = ? AND lb.state = 'unwatched'
     ORDER BY (mf.id_tspdt IS NOT NULL), f.latest_rank, mf.added_at`
  ).all(user);
  const unmatched = db.prepare(
    `SELECT name, year, lb_date FROM lb_unmatched WHERE cf_user = ? ORDER BY name COLLATE NOCASE`
  ).all(user);
  return { onlySite, lbRemoved, unmatched };
}

// Remove a single "not found" entry, or clear the whole list for a user.
export function dismissUnmatched(user, name, year) {
  getDb().prepare('DELETE FROM lb_unmatched WHERE cf_user=? AND name=? AND year=?').run(user, name, String(year ?? ''));
}
export function clearUnmatched(user) {
  getDb().prepare('DELETE FROM lb_unmatched WHERE cf_user=?').run(user);
}
