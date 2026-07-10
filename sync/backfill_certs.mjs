// Backfill age-rating certifications (all countries) for the top-ranked films
// into the queryable `film_cert` table, so the catalogue can be filtered by
// rating. Uses TMDB's release_dates. Zero dependencies (node:sqlite + fetch,
// Node >= 22). The app also fills film_cert lazily when a film is viewed; this
// just front-loads the popular end of the catalogue.
//
// Usage:
//   TSPDT_TMDB_KEY=xxx TSPDT_DB=/srv/films/tspdt.db node sync/backfill_certs.mjs [limit] [--force]
//   (limit defaults to 2000; --force re-fetches films that already have certs)
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { filmMinAge } from '../src/lib/server/certAge.mjs';

const argv = process.argv.slice(2);
const FORCE = argv.includes('--force');
const RECOMPUTE = argv.includes('--recompute-ages');
// No numeric arg => ALL ranked films (in rank order). Pass a number to cap it.
const LIMIT = parseInt(argv.find((a) => /^\d+$/.test(a)) || process.env.CERT_BACKFILL_LIMIT || '0', 10);
const SQL_LIMIT = LIMIT > 0 ? LIMIT : -1;   // SQLite: LIMIT -1 = no limit

const DB_PATH = [process.env.TSPDT_DB, resolve(process.cwd(), 'tspdt.db'), '/srv/films/tspdt.db']
  .filter(Boolean).find((p) => existsSync(p));
if (!DB_PATH) { console.error('tspdt.db not found (set TSPDT_DB).'); process.exit(1); }

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 8000;');
db.exec(`CREATE TABLE IF NOT EXISTS film_cert (
  id_tspdt INTEGER NOT NULL, country TEXT NOT NULL, cert TEXT NOT NULL,
  PRIMARY KEY (id_tspdt, country, cert));`);
db.exec('CREATE INDEX IF NOT EXISTS film_cert_cert ON film_cert(cert);');
db.exec('CREATE TABLE IF NOT EXISTS film_age (id_tspdt INTEGER PRIMARY KEY, min_age INTEGER NOT NULL);');
db.exec('CREATE INDEX IF NOT EXISTS film_age_age ON film_age(min_age);');

const ageUpsert = db.prepare('INSERT INTO film_age(id_tspdt, min_age) VALUES(?,?) ON CONFLICT(id_tspdt) DO UPDATE SET min_age=excluded.min_age');
const ageDel = db.prepare('DELETE FROM film_age WHERE id_tspdt = ?');
function storeAge(id, certRows) {
  const a = filmMinAge(certRows);
  if (a == null) ageDel.run(id); else ageUpsert.run(id, a);
}

// --recompute-ages: rebuild film_age from the already-downloaded film_cert (no
// network, no TMDB key). Run after changing the cert->age mapping in certAge.mjs.
if (RECOMPUTE) {
  const rows = db.prepare('SELECT id_tspdt, country, cert FROM film_cert ORDER BY id_tspdt').all();
  db.exec('BEGIN');
  let cur = null, certs = [], n = 0;
  const flush = () => { if (cur != null) { storeAge(cur, certs); n++; } };
  for (const r of rows) {
    if (r.id_tspdt !== cur) { flush(); cur = r.id_tspdt; certs = []; }
    certs.push({ country: r.country, cert: r.cert });
  }
  flush();
  db.exec('COMMIT');
  console.log(`Recomputed film_age for ${n} films from film_cert.`);
  db.close();
  process.exit(0);
}

const KEY = process.env.TSPDT_TMDB_KEY;
if (!KEY) { console.error('TSPDT_TMDB_KEY not set — skipping certification backfill.'); process.exit(0); }

const films = db.prepare(
  `SELECT id_tspdt, imdb_id FROM films
   WHERE removed_at IS NULL AND latest_rank IS NOT NULL AND imdb_id IS NOT NULL AND imdb_id <> ''
   ORDER BY latest_rank ASC LIMIT ?`
).all(SQL_LIMIT);

const hasCerts = db.prepare('SELECT 1 FROM film_cert WHERE id_tspdt = ? LIMIT 1');
const del = db.prepare('DELETE FROM film_cert WHERE id_tspdt = ?');
const ins = db.prepare('INSERT OR IGNORE INTO film_cert(id_tspdt, country, cert) VALUES(?,?,?)');

async function fetchJSON(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'tspdt-cinema/1.0' } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function backfill(film) {
  const find = await fetchJSON(`https://api.themoviedb.org/3/find/${film.imdb_id}?external_source=imdb_id&api_key=${KEY}`);
  const hit = find?.movie_results?.[0];
  if (!hit) return 0;
  const d = await fetchJSON(`https://api.themoviedb.org/3/movie/${hit.id}?api_key=${KEY}&append_to_response=release_dates`);
  const seen = new Set(); const certs = [];
  for (const c of (d?.release_dates?.results || [])) {
    for (const rd of (c.release_dates || [])) {
      const v = (rd.certification || '').trim();
      const k = c.iso_3166_1 + '|' + v;
      if (v && !seen.has(k)) { seen.add(k); certs.push([c.iso_3166_1, v]); }
    }
  }
  del.run(film.id_tspdt);
  for (const [country, cert] of certs) ins.run(film.id_tspdt, country, cert);
  storeAge(film.id_tspdt, certs.map(([country, cert]) => ({ country, cert })));
  return certs.length;
}

const CONC = 6;
let idx = 0, done = 0, rated = 0, certRows = 0, skipped = 0;
const start = Date.now();
async function worker() {
  while (idx < films.length) {
    const film = films[idx++];
    if (!FORCE && hasCerts.get(film.id_tspdt)) { skipped++; done++; continue; }
    const n = await backfill(film);
    if (n > 0) rated++;
    certRows += n; done++;
    if (done % 50 === 0) {
      const rate = done / ((Date.now() - start) / 1000);
      console.log(`  ${done}/${films.length}  rated=${rated} skipped=${skipped}  ${rate.toFixed(1)}/s  ETA ${Math.round((films.length - done) / rate)}s`);
    }
  }
}

console.log(`Backfilling certs for top ${films.length} films -> ${DB_PATH}${FORCE ? ' (force)' : ''}`);
await Promise.all(Array.from({ length: CONC }, worker));
console.log(`Done: ${done} processed, ${rated} had ratings (${certRows} cert rows), ${skipped} already had certs, ${((Date.now() - start) / 1000).toFixed(0)}s.`);
db.close();
