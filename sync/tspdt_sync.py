#!/usr/bin/env python3
"""
tspdt_sync.py -- Download the TSPDT "Starting List" and sync it into a SQLite DB.

Source: https://theyshootpictures.com/resources/StartingList.xls
        ("They Shoot Pictures, Don't They?" -- the master list behind the
         1,000 Greatest Films poll aggregation.)

Why this design is repeatable & robust
--------------------------------------
Every film is keyed on its stable ``idTSPDT`` identifier, so the sync does NOT
care what ROW a film lands on. The list is alphabetical by director, so adding a
single new director shifts thousands of rows down -- diffing by row position
would be hopeless; diffing by identity is trivial and correct.

Each run is idempotent and does the minimum work:
  * INSERT     films whose idTSPDT was never seen before
  * UPDATE     films whose content changed (detected via a per-film content hash)
  * REACTIVATE films that had been removed but reappeared
  * SOFT-DELETE films that vanished (sets ``removed_at``; history is preserved)
  * UNCHANGED  films are left completely untouched -> re-running is cheap

The per-edition rank columns (2026, 2025, ...) are stored in a normalised long
table keyed on an ``editions`` dimension. Adding a new poll-year column (or
dropping one) therefore needs NO schema change -- a new column just creates a new
edition row. This handles "new or removed entries in any row" *and* any column.

Hot read path
-------------
The common query is "the top films of the newest edition, by ascending rank"
(Citizen Kane, Vertigo, ...). To serve that without a join, each film caches its
rank in the newest edition in ``films.latest_rank`` / ``latest_edition_id``,
backed by a PARTIAL COVERING index over only the ranked films. The leaderboard
query is then an index-only range scan -- no join, no table fetch, no sort.
Obscure/unranked films aren't in that index at all.

Atomicity
---------
The whole run is one transaction: a failure leaves the DB exactly as it was.
(Note: we never use ``executescript`` inside the transaction -- it issues an
implicit COMMIT that would silently break atomicity.)

Dependencies: xlrd (``pip install xlrd``). Everything else is the standard library.

Usage
-----
  python tspdt_sync.py                 # download + sync into ./tspdt.db
  python tspdt_sync.py --file X.xls    # sync from a local copy (no download)
  python tspdt_sync.py --hard-delete   # physically delete vanished films
  python tspdt_sync.py --examples 8    # show N example rows in the report
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import subprocess
import sys
import time
import urllib.request
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

try:
    import xlrd
except ImportError:  # pragma: no cover
    sys.exit("Missing dependency 'xlrd'. Install it with:  pip install xlrd")

DEFAULT_URL = "https://theyshootpictures.com/resources/StartingList.xls"
SHEET = "StartingList"
NOTES_SHEET = "Notes"
OLE2_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"  # legacy .xls signature

# Header text (lower-cased) -> canonical film column name. Anything NOT listed
# here and sitting between the fixed fields is treated as a poll-edition column,
# so the parser survives renamed/added/removed fields without code changes.
FIELD_ALIASES = {
    "new": "is_new",
    "director(s)": "director",
    "director": "director",
    "title": "title",
    "year": "year",
    "country": "country",
    "length": "length_min",
    "colour": "colour",
    "color": "colour",
    "genre": "genre",
    "imdb": "imdb",
    "idtspdt": "id_tspdt",
}


# --------------------------------------------------------------------------- #
# Small helpers
# --------------------------------------------------------------------------- #
def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def as_int(v) -> int | None:
    """Coerce an xlrd cell to int, or None if blank/non-numeric.
    (Length cells that aren't plain numbers -> None; this is intentional --
    length_min is an integer-minutes field.)"""
    if v is None or v == "":
        return None
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


def as_text(v) -> str | None:
    """Coerce an xlrd cell to a trimmed string, or None if blank."""
    if v is None:
        return None
    if isinstance(v, float) and v.is_integer():  # numeric cells come back as float
        v = int(v)
    s = str(v).strip()
    return s or None


# --------------------------------------------------------------------------- #
# Step 1 - acquire the file
# --------------------------------------------------------------------------- #
def download(url: str, dest: Path, retries: int = 3) -> Path:
    """Download `url` to `dest`, retrying transient failures. Verifies it is a
    real OLE2 .xls before returning."""
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "tspdt-sync/1.0 (+https://theyshootpictures.com)"},
    )
    last_err: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            print(f"[download] {url}  (attempt {attempt}/{retries})")
            with urllib.request.urlopen(req, timeout=120) as resp:
                data = resp.read()
            if not data.startswith(OLE2_MAGIC):
                raise ValueError(
                    "Downloaded file is not a legacy .xls (bad OLE2 signature) -- "
                    "the site may have returned an error page."
                )
            dest.write_bytes(data)
            print(f"[download] saved {len(data):,} bytes -> {dest}")
            return dest
        except Exception as exc:  # noqa: BLE001 - report & retry
            last_err = exc
            print(f"[download] failed: {exc}")
            if attempt < retries:
                time.sleep(2 * attempt)
    raise RuntimeError(f"Could not download {url}: {last_err}")


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# --------------------------------------------------------------------------- #
# Step 2 - parse the workbook
# --------------------------------------------------------------------------- #
# module-level so parse_edition_header can see the workbook's date system
PARSE_DATEMODE = 0


def parse_edition_header(value) -> tuple[str, int | None, str | None]:
    """Turn a rank-column header into (label, poll_year, poll_date).

    Headers are usually a plain year (2026.0) but a couple are stored as Excel
    date serials that both fall in 2006 -- so the *label* (the distinct column
    identity) is what we key on, not the year. Callers additionally guarantee
    labels are globally unique (see parse_workbook)."""
    if isinstance(value, (int, float)):
        n = float(value)
        if 1900 <= n <= 2100:  # a plain year
            y = int(n)
            return str(y), y, f"{y:04d}-01-01"
        dt = xlrd.xldate.xldate_as_datetime(n, PARSE_DATEMODE)  # Excel date serial
        iso = dt.date().isoformat()
        return iso, dt.year, iso
    label = str(value).strip()
    m = re.search(r"(19|20)\d{2}", label)
    year = int(m.group(0)) if m else None
    return label, year, (f"{year:04d}-01-01" if year else None)


def parse_workbook(path: Path) -> dict:
    """Read the .xls and return a normalised snapshot ready to be synced."""
    global PARSE_DATEMODE
    book = xlrd.open_workbook(str(path), formatting_info=True)
    PARSE_DATEMODE = book.datemode
    sh = book.sheet_by_name(SHEET)

    # --- map header row -> column indices -------------------------------- #
    header = sh.row_values(0)
    col_of: dict[str, int] = {}
    editions: list[dict] = []
    used_labels: set[str] = set()
    for idx, raw in enumerate(header):
        key = str(raw).strip().lower()
        field = FIELD_ALIASES.get(key)
        if field:
            col_of[field] = idx
        elif str(raw).strip() != "":
            label, poll_year, poll_date = parse_edition_header(raw)
            if label in used_labels:            # never let two columns collide (edition.label is UNIQUE)
                label = f"{label}#col{idx}"
            used_labels.add(label)
            editions.append(
                {"col": idx, "label": label, "poll_year": poll_year, "poll_date": poll_date}
            )

    required = {"id_tspdt", "title", "director"}
    missing = required - col_of.keys()
    if missing:
        raise ValueError(f"Sheet {SHEET!r} is missing expected columns: {missing}")

    imdb_col = col_of.get("imdb")
    hyperlinks = getattr(sh, "hyperlink_map", {}) or {}

    # --- rows -> film records (last-wins dedup on idTSPDT) --------------- #
    by_id: dict[int, tuple[dict, list[tuple[str, int]]]] = {}
    skipped = 0
    duplicates = 0
    for r in range(1, sh.nrows):
        row = sh.row_values(r)
        id_tspdt = as_int(row[col_of["id_tspdt"]])
        if id_tspdt is None:
            skipped += 1
            continue

        # IMDb: prefer the cell's real hyperlink; fall back to its text value.
        imdb_url = None
        if imdb_col is not None:
            link = hyperlinks.get((r, imdb_col))
            if link is not None and link.url_or_path:
                imdb_url = link.url_or_path
            else:
                text = as_text(row[imdb_col])
                if text and ("imdb.com" in text or re.fullmatch(r"tt\d+", text)):
                    imdb_url = text
        imdb_id = None
        if imdb_url:
            m = re.search(r"(tt\d+)", imdb_url)
            imdb_id = m.group(1) if m else None

        rec = {
            "id_tspdt": id_tspdt,
            "is_new": (1 if "is_new" in col_of
                       and (as_text(row[col_of["is_new"]]) or "").lower() == "new"
                       else 0),
            "director": as_text(row[col_of["director"]]),
            "title": as_text(row[col_of["title"]]),
            "year": as_text(row[col_of["year"]]) if "year" in col_of else None,
            "country": as_text(row[col_of["country"]]) if "country" in col_of else None,
            "length_min": as_int(row[col_of["length_min"]]) if "length_min" in col_of else None,
            "colour": as_text(row[col_of["colour"]]) if "colour" in col_of else None,
            "genre": as_text(row[col_of["genre"]]) if "genre" in col_of else None,
            "imdb_id": imdb_id,
            "imdb_url": imdb_url,
        }

        # rankings: keep only real positions (0 == absent that edition)
        my_ranks: list[tuple[str, int]] = []
        for e in editions:
            pos = as_int(row[e["col"]])
            if pos and pos > 0:
                my_ranks.append((e["label"], pos))

        rec["content_hash"] = content_hash(rec, my_ranks)
        if id_tspdt in by_id:                    # duplicate key in the file -> last row wins
            duplicates += 1
        by_id[id_tspdt] = (rec, my_ranks)

    films = [rec for rec, _ in by_id.values()]
    rankings = [(idn, lbl, pos)
                for idn, (_, ranks) in by_id.items() for (lbl, pos) in ranks]

    # --- Notes sheet (documentation) ------------------------------------ #
    notes: list[tuple[int, str]] = []
    if NOTES_SHEET in book.sheet_names():
        ns = book.sheet_by_name(NOTES_SHEET)
        for r in range(ns.nrows):
            parts = [str(v).strip() for v in ns.row_values(r) if str(v).strip()]
            if parts:
                notes.append((r, "  |  ".join(parts)))

    return {
        "films": films, "rankings": rankings, "editions": editions,
        "notes": notes, "skipped": skipped, "duplicates": duplicates,
    }


def content_hash(rec: dict, ranks: list[tuple[str, int]]) -> str:
    """Stable hash of everything about a film. If ANY attribute or ranking
    changes, the hash changes -> the row is flagged for update. If nothing
    changes, the hash matches -> the row is skipped entirely."""
    parts = [
        str(rec["is_new"]), rec["director"] or "", rec["title"] or "",
        rec["year"] or "", rec["country"] or "", str(rec["length_min"] or ""),
        rec["colour"] or "", rec["genre"] or "", rec["imdb_url"] or "",
    ]
    parts.append("|".join(f"{lbl}={pos}" for lbl, pos in sorted(ranks)))
    return hashlib.sha256("\x1f".join(parts).encode("utf-8")).hexdigest()


# --------------------------------------------------------------------------- #
# Step 3 - schema
# --------------------------------------------------------------------------- #
SCHEMA = """
CREATE TABLE IF NOT EXISTS films (
    id_tspdt          INTEGER PRIMARY KEY,   -- TSPDT stable unique id (natural key)
    imdb_id           TEXT,                  -- e.g. tt0133191
    imdb_url          TEXT,
    tmdb_id           INTEGER,               -- populated for manual additions / enriched rows
    is_new            INTEGER NOT NULL DEFAULT 0,
    director          TEXT,
    title             TEXT,
    year              TEXT,                  -- kept as text (can be blank/range)
    country           TEXT,
    length_min        INTEGER,
    colour            TEXT,
    genre             TEXT,
    latest_rank       INTEGER,               -- cached rank in the newest edition (HOT PATH)
    latest_edition_id INTEGER REFERENCES editions(edition_id),
    content_hash      TEXT NOT NULL,         -- change-detection fingerprint
    first_seen        TEXT NOT NULL,         -- first sync that saw this film
    last_seen         TEXT NOT NULL,         -- most recent sync that saw it
    removed_at        TEXT                   -- set when it vanishes; NULL = present
);

CREATE TABLE IF NOT EXISTS editions (
    edition_id  INTEGER PRIMARY KEY AUTOINCREMENT,
    label       TEXT NOT NULL UNIQUE,        -- distinct column identity ("2026", "2006-12-01")
    poll_year   INTEGER,
    poll_date   TEXT                         -- for chronological sorting
);

CREATE TABLE IF NOT EXISTS rankings (
    id_tspdt    INTEGER NOT NULL REFERENCES films(id_tspdt) ON DELETE CASCADE,
    edition_id  INTEGER NOT NULL REFERENCES editions(edition_id) ON DELETE CASCADE,
    position    INTEGER NOT NULL,            -- rank in that edition (>=1)
    PRIMARY KEY (id_tspdt, edition_id)
);

-- Durable audit for movies added through the app. Active rows use a negative
-- id_tspdt; after a future spreadsheet match, merged_into records the official
-- positive TSPDT id and the temporary films row is retired.
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

CREATE TABLE IF NOT EXISTS notes (
    line_no  INTEGER PRIMARY KEY,            -- row in the source Notes sheet
    content  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_runs (
    run_id        INTEGER PRIMARY KEY AUTOINCREMENT,
    run_at        TEXT NOT NULL,
    source        TEXT,
    file_sha256   TEXT,
    rows_in_file  INTEGER,
    inserted      INTEGER,
    updated       INTEGER,
    unchanged     INTEGER,
    reactivated   INTEGER,
    removed       INTEGER,
    duplicates    INTEGER,
    reconciled    INTEGER NOT NULL DEFAULT 0,
    duration_sec  REAL
);

CREATE INDEX IF NOT EXISTS idx_rankings_edition ON rankings(edition_id, position);
CREATE INDEX IF NOT EXISTS idx_films_director   ON films(director);
CREATE INDEX IF NOT EXISTS idx_films_present    ON films(removed_at);
CREATE INDEX IF NOT EXISTS idx_films_imdb       ON films(imdb_id);
CREATE INDEX IF NOT EXISTS manual_films_active  ON manual_films(id_tspdt) WHERE merged_into IS NULL;
CREATE INDEX IF NOT EXISTS manual_films_imdb    ON manual_films(imdb_id) WHERE imdb_id IS NOT NULL;

-- HOT PATH: "top films of the newest edition". Partial (only ranked films) +
-- covering (rank,title,director,year) so the leaderboard query is answered by an
-- index-only range scan -- no table lookup, no sort, obscure films not indexed.
CREATE INDEX IF NOT EXISTS idx_films_leaderboard
    ON films(latest_rank, title, director, year)
    WHERE latest_rank IS NOT NULL;

-- Convenience: SELECT * FROM v_leaderboard LIMIT 20;  (uses the index above)
CREATE VIEW IF NOT EXISTS v_leaderboard AS
    SELECT latest_rank AS rank, title, director, year, country, genre,
           imdb_id, imdb_url, id_tspdt, latest_edition_id
    FROM films
    WHERE latest_rank IS NOT NULL
    ORDER BY latest_rank;
"""


def connect(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(db_path))
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.execute("PRAGMA journal_mode = WAL;")
    conn.execute("PRAGMA synchronous = NORMAL;")
    conn.execute("PRAGMA temp_store = MEMORY;")
    conn.execute("PRAGMA mmap_size = 268435456;")  # 256MB: memory-map for fast reads
    conn.execute("PRAGMA cache_size = -65536;")    # 64MB page cache
    conn.executescript(SCHEMA)                     # setup only -- outside any sync txn
    # CREATE TABLE IF NOT EXISTS does not add columns to an older database.
    film_cols = {r[1] for r in conn.execute("PRAGMA table_info(films)")}
    if "tmdb_id" not in film_cols:
        conn.execute("ALTER TABLE films ADD COLUMN tmdb_id INTEGER")
    run_cols = {r[1] for r in conn.execute("PRAGMA table_info(sync_runs)")}
    if "reconciled" not in run_cols:
        conn.execute("ALTER TABLE sync_runs ADD COLUMN reconciled INTEGER NOT NULL DEFAULT 0")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_films_tmdb ON films(tmdb_id) WHERE tmdb_id IS NOT NULL")
    conn.commit()
    return conn


# --------------------------------------------------------------------------- #
# Manual-film reconciliation
# --------------------------------------------------------------------------- #
_ARTICLES = {"the", "a", "an", "le", "la", "les", "los", "las", "il", "lo",
             "der", "die", "das", "ein", "eine", "de", "het", "een", "l'"}


def canonical_title(title: str | None) -> str:
    """Natural/article-suffix titles -> one conservative comparison key."""
    value = str(title or "").strip()
    match = re.match(r"^(.*),\s*([^\s,]+)$", value)
    if match and match.group(2).lower() in _ARTICLES:
        article = match.group(2)
        value = article + match.group(1) if article.endswith("'") else f"{article} {match.group(1)}"
    value = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^a-z0-9]+", "", value.lower())


def _table_exists(cur: sqlite3.Cursor, name: str) -> bool:
    return cur.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone() is not None


def _copy_rows_to_film(cur: sqlite3.Cursor, table: str, columns: list[str],
                       source_id: int, target_id: int, replace: bool = True) -> None:
    """Move rows whose first column is id_tspdt to the official film id."""
    if not _table_exists(cur, table):
        return
    available = {r[1] for r in cur.execute(f"PRAGMA table_info({table})")}
    columns = [column for column in columns if column in available]
    if not columns or columns[0] != "id_tspdt":
        return
    rows = cur.execute(
        f"SELECT {','.join(columns)} FROM {table} WHERE id_tspdt=?", (source_id,)
    ).fetchall()
    verb = "INSERT OR REPLACE" if replace else "INSERT OR IGNORE"
    placeholders = ",".join("?" for _ in columns)
    for row in rows:
        cur.execute(
            f"{verb} INTO {table}({','.join(columns)}) VALUES({placeholders})",
            (target_id, *row[1:]),
        )
    cur.execute(f"DELETE FROM {table} WHERE id_tspdt=?", (source_id,))


def _merge_manual_film(cur: sqlite3.Cursor, manual: sqlite3.Row | tuple,
                       target_id: int, timestamp: str) -> None:
    tmdb_id, source_id, _imdb_id, _title, _year = manual
    cur.execute("UPDATE films SET tmdb_id=COALESCE(tmdb_id,?) WHERE id_tspdt=?", (tmdb_id, target_id))

    # User/global state follows the movie. For the rare conflict, the manually
    # added row wins: it reflects the more recent interaction with this identity.
    _copy_rows_to_film(cur, "user_status",
                       ["id_tspdt", "cf_user", "status", "updated_at"], source_id, target_id)
    _copy_rows_to_film(cur, "lb_seen",
                       ["id_tspdt", "cf_user", "state", "lb_date", "imported_at", "updated_at"],
                       source_id, target_id)
    _copy_rows_to_film(cur, "playback",
                       ["id_tspdt", "cf_user", "position", "duration", "updated_at"], source_id, target_id)
    _copy_rows_to_film(cur, "film_download",
                       ["id_tspdt", "state", "progress"], source_id, target_id)
    _copy_rows_to_film(cur, "film_cert",
                       ["id_tspdt", "country", "cert"], source_id, target_id, replace=False)
    _copy_rows_to_film(cur, "film_age", ["id_tspdt", "min_age"], source_id, target_id)

    # Keep the richest cached TMDB record and rewrite its local image routes to
    # the official id. Cached image bytes can be fetched again on first access.
    if _table_exists(cur, "film_meta"):
        source_meta = cur.execute(
            "SELECT level,json,fetched_at FROM film_meta WHERE id_tspdt=?", (source_id,)
        ).fetchone()
        target_meta = cur.execute(
            "SELECT fetched_at FROM film_meta WHERE id_tspdt=?", (target_id,)
        ).fetchone()
        if source_meta and (not target_meta or str(source_meta[2]) >= str(target_meta[0])):
            try:
                payload = json.loads(source_meta[1])
                payload["id_tspdt"] = target_id
                if payload.get("poster_src"):
                    payload["poster"] = f"/img/poster/{target_id}"
                if payload.get("backdrop_src"):
                    payload["backdrop"] = f"/img/backdrop/{target_id}"
                meta_json = json.dumps(payload, separators=(",", ":"))
            except (TypeError, ValueError):
                meta_json = source_meta[1]
            cur.execute(
                "INSERT OR REPLACE INTO film_meta(id_tspdt,level,json,fetched_at) VALUES(?,?,?,?)",
                (target_id, source_meta[0], meta_json, source_meta[2]),
            )
        cur.execute("DELETE FROM film_meta WHERE id_tspdt=?", (source_id,))

    # The audit row deliberately has no film FK: it becomes a permanent alias
    # from the old negative id/TMDB identity to the official TSPDT row.
    cur.execute(
        "UPDATE manual_films SET merged_into=?, merged_at=? WHERE tmdb_id=?",
        (target_id, timestamp, tmdb_id),
    )
    cur.execute("DELETE FROM films WHERE id_tspdt=?", (source_id,))


def reconcile_manual_films(cur: sqlite3.Cursor, timestamp: str) -> int:
    manuals = cur.execute(
        "SELECT tmdb_id,id_tspdt,imdb_id,title,year FROM manual_films WHERE merged_into IS NULL"
    ).fetchall()
    if not manuals:
        return 0
    incoming = cur.execute("SELECT id_tspdt,imdb_id,title,year FROM stg_films").fetchall()
    by_imdb: dict[str, list[int]] = {}
    by_title: dict[str, list[tuple[int, int | None]]] = {}
    for film_id, imdb_id, title, year in incoming:
        if imdb_id:
            by_imdb.setdefault(str(imdb_id), []).append(film_id)
        key = canonical_title(title)
        if key:
            try: film_year = int(year)
            except (TypeError, ValueError): film_year = None
            by_title.setdefault(key, []).append((film_id, film_year))

    pairs: list[tuple[tuple, int]] = []
    used_targets: set[int] = set()
    for manual in manuals:
        _tmdb_id, _source_id, imdb_id, title, year = manual
        target = None
        strong = by_imdb.get(str(imdb_id), []) if imdb_id else []
        if len(strong) == 1:
            target = strong[0]
        if target is None:
            candidates = by_title.get(canonical_title(title), [])
            try: manual_year = int(year)
            except (TypeError, ValueError): manual_year = None
            if manual_year is not None:
                candidates = [c for c in candidates if c[1] is not None and abs(c[1] - manual_year) <= 1]
            if len(candidates) == 1:
                target = candidates[0][0]
        if target is not None and target not in used_targets:
            used_targets.add(target)
            pairs.append((manual, target))

    for manual, target in pairs:
        _merge_manual_film(cur, manual, target, timestamp)
    return len(pairs)


# --------------------------------------------------------------------------- #
# Step 4 - the sync (all set-based, ONE real transaction)
# --------------------------------------------------------------------------- #
def sync(conn: sqlite3.Connection, snap: dict, source: str,
         file_sha: str | None, hard_delete: bool) -> dict:
    if not snap["films"]:
        # Refuse to sync an empty parse -- it would soft-remove/delete everything.
        raise ValueError("Parsed 0 films from the workbook; refusing to sync.")

    ts = now_iso()
    started = time.perf_counter()
    cur = conn.cursor()
    cur.execute("BEGIN")                # NB: no executescript() below -> stays atomic
    try:
        # 0) upsert edition dimension (new poll-year columns appear here automatically)
        cur.executemany(
            """INSERT INTO editions(label, poll_year, poll_date)
               VALUES(:label,:poll_year,:poll_date)
               ON CONFLICT(label) DO UPDATE SET poll_year=excluded.poll_year,
                                                poll_date=excluded.poll_date""",
            snap["editions"],
        )

        # 1) stage the incoming snapshot in TEMP tables (bulk, fast)
        for stmt in (
            "DROP TABLE IF EXISTS stg_films",
            "DROP TABLE IF EXISTS stg_rankings",
            "DROP TABLE IF EXISTS dirty",
            """CREATE TEMP TABLE stg_films (
                   id_tspdt INTEGER PRIMARY KEY, imdb_id TEXT, imdb_url TEXT, is_new INTEGER,
                   director TEXT, title TEXT, year TEXT, country TEXT, length_min INTEGER,
                   colour TEXT, genre TEXT, content_hash TEXT)""",
            "CREATE TEMP TABLE stg_rankings (id_tspdt INTEGER, label TEXT, position INTEGER)",
            "CREATE TEMP TABLE dirty (id_tspdt INTEGER PRIMARY KEY)",
        ):
            cur.execute(stmt)
        cur.executemany(
            """INSERT INTO stg_films VALUES
               (:id_tspdt,:imdb_id,:imdb_url,:is_new,:director,:title,:year,:country,
                :length_min,:colour,:genre,:content_hash)""",
            snap["films"],
        )
        cur.executemany("INSERT INTO stg_rankings VALUES (?,?,?)", snap["rankings"])

        # 2) reactivated = films present now that were previously removed (count first)
        reactivated = cur.execute(
            "SELECT count(*) FROM stg_films s JOIN films f USING(id_tspdt) "
            "WHERE f.removed_at IS NOT NULL"
        ).fetchone()[0]

        # 3) which films need attributes/rankings rewritten? (new OR changed) -- before updates
        cur.execute(
            """INSERT INTO dirty(id_tspdt)
               SELECT s.id_tspdt FROM stg_films s LEFT JOIN films f USING(id_tspdt)
               WHERE f.id_tspdt IS NULL OR f.content_hash <> s.content_hash"""
        )

        # 4) INSERT brand-new films
        cur.execute(
            """INSERT INTO films (id_tspdt,imdb_id,imdb_url,is_new,director,title,year,
                                  country,length_min,colour,genre,content_hash,
                                  first_seen,last_seen,removed_at)
               SELECT s.id_tspdt,s.imdb_id,s.imdb_url,s.is_new,s.director,s.title,s.year,
                      s.country,s.length_min,s.colour,s.genre,s.content_hash,?,?,NULL
               FROM stg_films s LEFT JOIN films f USING(id_tspdt)
               WHERE f.id_tspdt IS NULL""",
            (ts, ts),
        )
        inserted = cur.rowcount

        # 5) UPDATE changed films (UPDATE ... FROM, requires SQLite >= 3.33)
        cur.execute(
            """UPDATE films SET
                   imdb_id=s.imdb_id, imdb_url=s.imdb_url, is_new=s.is_new,
                   director=s.director, title=s.title, year=s.year, country=s.country,
                   length_min=s.length_min, colour=s.colour, genre=s.genre,
                   content_hash=s.content_hash
               FROM stg_films s
               WHERE films.id_tspdt=s.id_tspdt AND films.content_hash <> s.content_hash"""
        )
        updated = cur.rowcount

        # 6) every present film: bump last_seen and clear any prior removal (reactivate)
        cur.execute(
            "UPDATE films SET last_seen=?, removed_at=NULL "
            "WHERE id_tspdt IN (SELECT id_tspdt FROM stg_films)",
            (ts,),
        )

        # A movie added through the app may acquire a real TSPDT identity in
        # this snapshot. Move all of its state to that positive id before the
        # source lifecycle and ranking maintenance continue.
        reconciled = reconcile_manual_films(cur, ts)

        # 7) films that vanished from the file
        if hard_delete:
            # Delete absent source films, never active manual additions.
            cur.execute(
                """DELETE FROM films
                   WHERE id_tspdt NOT IN (SELECT id_tspdt FROM stg_films)
                     AND NOT EXISTS (
                       SELECT 1 FROM manual_films mf
                       WHERE mf.id_tspdt=films.id_tspdt AND mf.merged_into IS NULL
                     )"""
            )
        else:
            cur.execute(
                "UPDATE films SET removed_at=? WHERE removed_at IS NULL "
                "AND id_tspdt NOT IN (SELECT id_tspdt FROM stg_films) "
                "AND NOT EXISTS (SELECT 1 FROM manual_films mf "
                "WHERE mf.id_tspdt=films.id_tspdt AND mf.merged_into IS NULL)",
                (ts,),
            )
        removed = cur.rowcount

        # 8) rankings: only rewrite for new/changed films (unchanged rankings are
        #    part of the content hash, so they can't have changed).
        cur.execute("DELETE FROM rankings WHERE id_tspdt IN (SELECT id_tspdt FROM dirty)")
        cur.execute(
            """INSERT INTO rankings (id_tspdt, edition_id, position)
               SELECT sr.id_tspdt, e.edition_id, sr.position
               FROM stg_rankings sr
               JOIN editions e ON e.label = sr.label
               JOIN dirty d   ON d.id_tspdt = sr.id_tspdt"""
        )

        # 9) maintain the denormalised latest-edition rank (hot read path).
        #    Both statements are guarded so an idempotent re-run writes ZERO rows.
        latest = cur.execute(
            "SELECT edition_id FROM editions ORDER BY poll_date DESC, edition_id DESC LIMIT 1"
        ).fetchone()
        if latest is not None:
            latest_eid = latest[0]
            cur.execute(
                """UPDATE films
                     SET latest_rank=r.position, latest_edition_id=r.edition_id
                   FROM rankings r
                   WHERE r.id_tspdt=films.id_tspdt AND r.edition_id=?
                     AND films.removed_at IS NULL
                     AND (films.latest_rank IS NOT r.position
                          OR films.latest_edition_id IS NOT r.edition_id)""",
                (latest_eid,),
            )
            cur.execute(
                """UPDATE films SET latest_rank=NULL, latest_edition_id=NULL
                   WHERE latest_rank IS NOT NULL
                     AND (removed_at IS NOT NULL
                          OR id_tspdt NOT IN
                             (SELECT id_tspdt FROM rankings WHERE edition_id=?))""",
                (latest_eid,),
            )

        # 10) refresh the Notes documentation table
        cur.execute("DELETE FROM notes")
        cur.executemany("INSERT INTO notes(line_no, content) VALUES(?,?)", snap["notes"])

        # 11) audit row
        unchanged = len(snap["films"]) - inserted - updated
        duration = round(time.perf_counter() - started, 3)
        stats = {
            "run_at": ts, "source": source, "file_sha256": file_sha,
            "rows_in_file": len(snap["films"]), "inserted": inserted, "updated": updated,
            "unchanged": unchanged, "reactivated": reactivated, "removed": removed,
            "duplicates": snap.get("duplicates", 0), "reconciled": reconciled,
            "duration_sec": duration,
        }
        cur.execute(
            """INSERT INTO sync_runs(run_at,source,file_sha256,rows_in_file,inserted,
                                     updated,unchanged,reactivated,removed,duplicates,
                                     reconciled,duration_sec)
               VALUES(:run_at,:source,:file_sha256,:rows_in_file,:inserted,:updated,
                      :unchanged,:reactivated,:removed,:duplicates,:reconciled,:duration_sec)""",
            stats,
        )

        # tidy the staging tables (kept inside the txn -> no implicit commit)
        for stmt in ("DROP TABLE stg_films", "DROP TABLE stg_rankings", "DROP TABLE dirty"):
            cur.execute(stmt)

        conn.commit()
    except Exception:
        conn.rollback()
        raise

    conn.execute("PRAGMA optimize")     # refresh planner stats for the new data
    return stats


# --------------------------------------------------------------------------- #
# Step 5 - report
# --------------------------------------------------------------------------- #
def report(conn: sqlite3.Connection, stats: dict, n_examples: int) -> None:
    cur = conn.cursor()
    line = "=" * 78

    print(f"\n{line}\nSYNC SUMMARY\n{line}")
    for k in ("run_at", "rows_in_file", "inserted", "updated", "unchanged",
              "reactivated", "removed", "duplicates", "reconciled", "duration_sec"):
        print(f"  {k:14} : {stats[k]}")

    print(f"\n{line}\nDATABASE SCHEMA (tables, indexes, views)\n{line}")
    for (sql,) in cur.execute(
        "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' "
        "ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name"
    ):
        print(sql.strip() + ";\n")

    print(f"{line}\nTABLE ROW COUNTS\n{line}")
    for t in ("films", "editions", "rankings", "notes", "sync_runs"):
        n = cur.execute(f"SELECT count(*) FROM {t}").fetchone()[0]
        print(f"  {t:12} : {n:,}")
    present = cur.execute("SELECT count(*) FROM films WHERE removed_at IS NULL").fetchone()[0]
    rmvd = cur.execute("SELECT count(*) FROM films WHERE removed_at IS NOT NULL").fetchone()[0]
    ranked = cur.execute("SELECT count(*) FROM films WHERE latest_rank IS NOT NULL").fetchone()[0]
    print(f"  (present={present:,}, soft-removed={rmvd:,}, ranked in latest edition={ranked:,})")

    print(f"\n{line}\nEDITIONS (poll columns, newest first)\n{line}")
    for eid, label, py in cur.execute(
        "SELECT edition_id,label,poll_year FROM editions ORDER BY poll_date DESC, edition_id DESC"):
        print(f"  #{eid:<3} label={label:<14} poll_year={py}")

    latest = cur.execute(
        "SELECT edition_id,label,poll_year FROM editions ORDER BY poll_date DESC, edition_id DESC LIMIT 1"
    ).fetchone()
    print(f"\n{line}\nTOP FILMS -- newest edition '{latest[1]}' (the hot path)\n{line}")
    hdr = ("Rank", "Title", "Director", "Yr", "Country", "IMDb")
    widths = (5, 34, 22, 5, 13, 11)
    print("  " + "  ".join(f"{h:<{w}}" for h, w in zip(hdr, widths)))
    print("  " + "  ".join("-" * w for w in widths))
    for rank, title, director, year, country, genre, imdb_id, imdb_url, idt, eid in cur.execute(
        "SELECT * FROM v_leaderboard LIMIT ?", (n_examples,)):
        cells = [str(rank), (title or "")[:34], (director or "")[:22], str(year or ""),
                 (country or "")[:13], imdb_id or ""]
        print("  " + "  ".join(f"{c:<{w}}" for c, w in zip(cells, widths)))

    print(f"\n{line}\nQUERY PLAN for the hot leaderboard query (proof: index-only, no scan/sort)\n{line}")
    q = ("SELECT latest_rank, title, director, year FROM films "
         "WHERE latest_rank IS NOT NULL ORDER BY latest_rank LIMIT 10")
    print(f"  {q}\n")
    for row in cur.execute("EXPLAIN QUERY PLAN " + q):
        print("    " + " | ".join(str(x) for x in row))

    print(f"\n{line}\nEXAMPLE 'rankings' rows (long/normalised) -- rank history of the #1 film\n{line}")
    top = cur.execute("SELECT id_tspdt, title FROM v_leaderboard LIMIT 1").fetchone()
    if top:
        print(f"  {top[1]!r}  (idTSPDT={top[0]}):")
        for lbl, py, pos in cur.execute(
            """SELECT e.label, e.poll_year, r.position
               FROM rankings r JOIN editions e USING(edition_id)
               WHERE r.id_tspdt=? ORDER BY e.poll_date DESC, e.edition_id DESC""", (top[0],)):
            print(f"      edition {lbl:<14} (poll_year {py})  ->  rank {pos}")
    print(line)


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #
def run_cert_backfill(db_path: Path) -> None:
    """After a sync, top up age-rating certifications for any films that don't
    have them yet -- so films newly imported from the Starting List get their
    ratings without anyone remembering to run a separate step. Best-effort: it
    needs TSPDT_TMDB_KEY and Node >= 22, and is skipped quietly otherwise so it
    can never block or fail a sync. The node script only fetches films that are
    missing certs, so re-running it is cheap and idempotent."""
    if not os.environ.get("TSPDT_TMDB_KEY"):
        print("[certs]  TSPDT_TMDB_KEY not set -- skipping age-rating backfill.")
        return
    script = Path(__file__).with_name("backfill_certs.mjs")
    if not script.exists():
        return
    print("[certs]  backfilling age ratings for films missing them (node backfill_certs.mjs)...")
    try:
        subprocess.run(["node", str(script)], env={**os.environ, "TSPDT_DB": str(db_path)}, check=False)
    except FileNotFoundError:
        print("[certs]  node not found -- skipping age-rating backfill.")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Sync the TSPDT Starting List into SQLite.")
    ap.add_argument("--url", default=DEFAULT_URL, help="source .xls URL")
    ap.add_argument("--file", type=Path, help="use a local .xls instead of downloading")
    ap.add_argument("--db", type=Path, default=Path("tspdt.db"), help="SQLite db path")
    ap.add_argument("--download-path", type=Path, default=Path("StartingList.xls"),
                    help="where to save the downloaded .xls")
    ap.add_argument("--hard-delete", action="store_true",
                    help="physically delete vanished films instead of soft-deleting")
    ap.add_argument("--no-certs", action="store_true",
                    help="skip the post-sync age-rating backfill (backfill_certs.mjs)")
    ap.add_argument("--examples", type=int, default=10, help="example rows to print")
    args = ap.parse_args(argv)

    if args.file:
        xls_path, source = args.file, str(args.file)
        if not xls_path.exists():
            sys.exit(f"--file not found: {xls_path}")
    else:
        xls_path = download(args.url, args.download_path)
        source = args.url

    file_sha = sha256_of(xls_path)
    print(f"[parse]  reading {xls_path}  (sha256={file_sha[:16]}...)")
    snap = parse_workbook(xls_path)
    print(f"[parse]  {len(snap['films']):,} films, {len(snap['rankings']):,} ranking rows, "
          f"{len(snap['editions'])} editions, {len(snap['notes'])} notes "
          f"({snap['skipped']} skipped no-id, {snap['duplicates']} dup-id last-wins)")

    conn = connect(args.db)
    try:
        sqlite_ver = conn.execute("SELECT sqlite_version()").fetchone()[0]
        print(f"[db]     {args.db}  (SQLite {sqlite_ver})")
        stats = sync(conn, snap, source, file_sha, args.hard_delete)
        print(f"[sync]   +{stats['inserted']} new  ~{stats['updated']} changed  "
              f"={stats['unchanged']} same  ^{stats['reactivated']} reactivated  "
              f"-{stats['removed']} removed  >{stats['reconciled']} manual merged  "
              f"in {stats['duration_sec']}s")
        report(conn, stats, args.examples)
    finally:
        conn.close()
    if not args.no_certs:
        run_cert_backfill(args.db)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
