// Server-only data layer. Reads the tspdt.db built by sync/tspdt_sync.py via
// the built-in node:sqlite module -- no native dependency to compile.
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  // Personal state + availability/metadata caches -- added alongside the synced
  // data; the Python sync never touches these tables.
  //   * user_status is PER USER: keyed on (cf_user, id_tspdt) so each Cloudflare
  //     Access identity has its own watchlist / seen list.
  //   * film_meta is a film property (poster art, ratings), shared across users
  //     -- deliberately NOT per user.
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_status (
      cf_user    TEXT NOT NULL,
      id_tspdt   INTEGER NOT NULL REFERENCES films(id_tspdt) ON DELETE CASCADE,
      status     TEXT NOT NULL CHECK(status IN ('watchlist','seen')),
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (cf_user, id_tspdt)
    );
    CREATE TABLE IF NOT EXISTS film_meta (
      id_tspdt      INTEGER PRIMARY KEY REFERENCES films(id_tspdt) ON DELETE CASCADE,
      level         TEXT,
      json          TEXT NOT NULL,
      fetched_at    TEXT DEFAULT (datetime('now'))
    );
  `);
  _db = db;
  return _db;
}

/* -------------------------------------------------------------- facets ---- */
let _facets = null;
export function getFacets() {
  if (_facets) return _facets;
  const db = getDb();
  const rows = db.prepare(
    'SELECT country, genre, colour, year FROM films WHERE removed_at IS NULL AND latest_rank IS NOT NULL'
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
  const total = db.prepare('SELECT count(*) c FROM films WHERE removed_at IS NULL AND latest_rank IS NOT NULL').get().c;
  const latest = db.prepare('SELECT label, poll_year FROM editions ORDER BY poll_date DESC, edition_id DESC LIMIT 1').get();
  _facets = {
    total,
    latestEdition: latest?.label ?? null,
    latestPollYear: latest?.poll_year ?? null,
    countries: top(countries, 80),
    genres: top(genres, 60),
    colours: top(colours, 6),
    decades: [...decades.entries()].sort((a, b) => a[0] - b[0]).map(([value, count]) => ({ value, count }))
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
  const where = ['f.removed_at IS NULL', 'f.latest_rank IS NOT NULL'];
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

  // Per-user join: the status column (and the status filter) reflect THIS user.
  const join = 'LEFT JOIN user_status us ON us.id_tspdt = f.id_tspdt AND us.cf_user = ?';
  if (p.status === 'watchlist' || p.status === 'seen') { where.push('us.status = ?'); args.push(p.status); }

  const sort = Object.hasOwn(SORTS, p.sort) ? SORTS[p.sort] : SORTS.rank;  // no prototype read-through
  const order = p.order === 'desc' ? 'DESC' : 'ASC';
  const limit = Math.trunc(Math.max(1, Math.min(120, +p.limit || 60)));   // integer for LIMIT/OFFSET
  const offset = Math.max(0, Math.trunc(+p.offset || 0));
  const wc = where.join(' AND ');

  // The join's `?` (user) binds before the WHERE args; LIMIT/OFFSET bind last.
  const total = db.prepare(`SELECT count(*) c FROM films f ${join} WHERE ${wc}`).get(user, ...args).c;
  const items = db.prepare(
    `SELECT f.id_tspdt, f.latest_rank AS rank, f.title, f.year, f.director, f.country,
            f.genre, f.length_min, f.colour, f.imdb_id, f.imdb_url, f.is_new, us.status
     FROM films f ${join} WHERE ${wc}
     ORDER BY ${sort} ${order}, f.latest_rank ASC
     LIMIT ? OFFSET ?`
  ).all(user, ...args, limit, offset);
  return { total, items };
}

export function getFilmBasic(id) {
  return getDb().prepare(
    'SELECT id_tspdt, imdb_id, imdb_url, title, year FROM films WHERE id_tspdt = ?'
  ).get(id) || null;
}

export function getFilm(id, user = 'local') {
  const db = getDb();
  const row = db.prepare(
    `SELECT f.*, us.status
     FROM films f
     LEFT JOIN user_status us ON us.id_tspdt = f.id_tspdt AND us.cf_user = ?
     WHERE f.id_tspdt = ?`
  ).get(user, id);
  if (!row) return null;
  delete row.content_hash;
  row.history = db.prepare(
    `SELECT e.label, e.poll_year, r.position FROM rankings r
     JOIN editions e USING(edition_id) WHERE r.id_tspdt = ?
     ORDER BY e.poll_date ASC, e.edition_id ASC`
  ).all(id);
  return row;
}

/* -------------------------------------------------------------- status ---- */
export function setStatus(user, id, status) {
  const db = getDb();
  if (status === 'watchlist' || status === 'seen') {
    db.prepare(
      `INSERT INTO user_status(cf_user, id_tspdt, status, updated_at) VALUES(?,?,?,datetime('now'))
       ON CONFLICT(cf_user, id_tspdt) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at`
    ).run(user, id, status);
  } else {
    db.prepare('DELETE FROM user_status WHERE cf_user = ? AND id_tspdt = ?').run(user, id);
    status = null;
  }
  return { status, counts: counts(user) };
}

export function counts(user = 'local') {
  const r = getDb().prepare(
    `SELECT COALESCE(SUM(status='watchlist'),0) watchlist, COALESCE(SUM(status='seen'),0) seen
     FROM user_status WHERE cf_user = ?`
  ).get(user);
  return { watchlist: r.watchlist, seen: r.seen };
}

/* ------------------------------------------------- enrichment cache ------ */
export function getMetaCache(id) {
  return getDb().prepare('SELECT json, level, fetched_at FROM film_meta WHERE id_tspdt = ?').get(id) || null;
}
export function setMetaCache(id, obj, level) {
  getDb().prepare(
    `INSERT INTO film_meta(id_tspdt, level, json, fetched_at) VALUES(?,?,?,datetime('now'))
     ON CONFLICT(id_tspdt) DO UPDATE SET level=excluded.level, json=excluded.json, fetched_at=excluded.fetched_at`
  ).run(id, level, JSON.stringify(obj));
}
