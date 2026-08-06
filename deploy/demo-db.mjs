#!/usr/bin/env node
// Seed the public demo's database from the private one.
//
//   node deploy/demo-db.mjs /srv/films/tspdt.db /srv/films-demo/tspdt.db
//
// The demo serves the same catalogue but must carry none of the private
// instance's state. Two separate concerns:
//
//   * PRIVACY — user_status / lb_seen / lb_unmatched / playback are one person's
//     viewing history, and manual_films records who added a title. None of it
//     belongs on a public site, so all of it is dropped.
//   * HONESTY — film_download is Radarr's view of a library the demo has no
//     access to. Left in place, cards would show "in library" badges for files
//     that cannot be played here.
//
// Kept deliberately: films, rankings, editions, film_meta, film_cert, film_age,
// film_watch — the catalogue and its (shared, impersonal) metadata caches, so
// the demo starts warm instead of re-fetching TMDB for 26,500 titles.
//
// Re-runnable: the destination is replaced wholesale. VACUUM INTO takes a
// consistent snapshot of a live WAL database, so the running site needs no
// downtime.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const src = resolve(process.argv[2] || '/srv/films/tspdt.db');
const dest = resolve(process.argv[3] || '/srv/films-demo/tspdt.db');

if (!existsSync(src)) {
  console.error(`source database not found: ${src}`);
  process.exit(1);
}
if (src === dest) {
  console.error('refusing to scrub the source database in place');
  process.exit(1);
}

mkdirSync(dirname(dest), { recursive: true });
for (const suffix of ['', '-wal', '-shm']) rmSync(dest + suffix, { force: true });

const src_db = new DatabaseSync(src, { readOnly: true });
// VACUUM INTO writes a fully-compacted copy; -wal/-shm are folded in, so the
// destination is a single self-contained file.
src_db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
src_db.close();

const db = new DatabaseSync(dest);
const before = (t) => {
  try { return db.prepare(`SELECT count(*) c FROM ${t}`).get().c; } catch { return null; }
};

// Per-visitor tables the demo repopulates from scratch, one cookie at a time.
const PRIVATE = ['user_status', 'lb_seen', 'lb_unmatched', 'playback'];
// Radarr's library view — meaningless without the media stack behind it.
const HOME_ONLY = ['film_download'];

const report = [];
db.exec('BEGIN');
try {
  for (const t of [...PRIVATE, ...HOME_ONLY]) {
    const n = before(t);
    if (n === null) continue;            // table absent in an older schema
    db.exec(`DELETE FROM ${t}`);
    report.push([t, n]);
  }
  // manual_films.added_by is an email address; the addition itself stays (it is
  // part of the catalogue), the identity behind it does not.
  try { db.exec("UPDATE manual_films SET added_by='demo' WHERE added_by IS NOT NULL"); } catch { /* table absent */ }
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  throw e;
}
db.exec('VACUUM');

const films = db.prepare('SELECT count(*) c FROM films WHERE removed_at IS NULL').get().c;
const meta = before('film_meta') ?? 0;
db.close();

console.log(`demo database written: ${dest}`);
console.log(`  ${films.toLocaleString()} films, ${meta.toLocaleString()} cached metadata rows`);
for (const [t, n] of report) console.log(`  cleared ${t}: ${n.toLocaleString()} row(s)`);
