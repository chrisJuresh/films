import importlib.util
import json
import sqlite3
import sys
import tempfile
import types
import unittest
from pathlib import Path

# The reconciliation layer is pure SQLite and does not parse workbooks. Stub
# xlrd so this focused test does not require the optional sync environment.
sys.modules.setdefault("xlrd", types.SimpleNamespace())
MODULE_PATH = Path(__file__).parents[1] / "sync" / "tspdt_sync.py"
SPEC = importlib.util.spec_from_file_location("tspdt_sync", MODULE_PATH)
sync = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sync)


class ManualReconciliationTest(unittest.TestCase):
    def test_manual_identity_and_state_move_to_official_tspdt_id(self):
        with tempfile.TemporaryDirectory() as directory:
            conn = sync.connect(Path(directory) / "films.db")
            conn.executescript("""
              CREATE TABLE user_status (
                cf_user TEXT NOT NULL, id_tspdt INTEGER NOT NULL REFERENCES films(id_tspdt) ON DELETE CASCADE,
                status TEXT NOT NULL, updated_at TEXT, PRIMARY KEY(cf_user,id_tspdt)
              );
              CREATE TABLE film_meta (
                id_tspdt INTEGER PRIMARY KEY REFERENCES films(id_tspdt) ON DELETE CASCADE,
                level TEXT, json TEXT NOT NULL, fetched_at TEXT
              );
            """)
            values = (-99, "tt1234567", "https://www.imdb.com/title/tt1234567/", 99, 0,
                      "Jane Director", "A Future Classic", "2026", "UK", 100, None, "Drama",
                      None, None, "manual:tmdb:99", "2026-01-01", "2026-01-01", None)
            conn.execute("INSERT INTO films VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", values)
            conn.execute(
                "INSERT INTO manual_films(tmdb_id,id_tspdt,imdb_id,title,year,added_by) VALUES(?,?,?,?,?,?)",
                (99, -99, "tt1234567", "A Future Classic", "2026", "viewer@example.com"),
            )
            conn.execute("INSERT INTO user_status VALUES(?,?,?,?)", ("viewer@example.com", -99, "watchlist", "2026-01-02"))
            conn.execute(
                "INSERT INTO film_meta VALUES(?,?,?,?)",
                (-99, "full", json.dumps({"id_tspdt": -99, "tmdb_id": 99, "poster_src": "https://image.tmdb.org/x.jpg", "poster": "/img/poster/-99"}), "2026-01-02"),
            )
            official = (501, "tt1234567", "https://www.imdb.com/title/tt1234567/", None, 1,
                        "Jane Director", "Future Classic, A", "2026", "UK", 100, "Col", "Drama",
                        88, None, "official", "2026-07-18", "2026-07-18", None)
            conn.execute("INSERT INTO films VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", official)
            conn.execute("CREATE TEMP TABLE stg_films(id_tspdt INTEGER, imdb_id TEXT, title TEXT, year TEXT)")
            conn.execute("INSERT INTO stg_films VALUES(?,?,?,?)", (501, "tt1234567", "Future Classic, A", "2026"))

            conn.commit()
            conn.execute("BEGIN")
            merged = sync.reconcile_manual_films(conn.cursor(), "2026-07-18T20:00:00+00:00")
            conn.commit()

            self.assertEqual(merged, 1)
            self.assertIsNone(conn.execute("SELECT 1 FROM films WHERE id_tspdt=-99").fetchone())
            self.assertEqual(conn.execute("SELECT tmdb_id FROM films WHERE id_tspdt=501").fetchone()[0], 99)
            self.assertEqual(conn.execute("SELECT status FROM user_status WHERE id_tspdt=501").fetchone()[0], "watchlist")
            audit = conn.execute("SELECT merged_into,merged_at FROM manual_films WHERE tmdb_id=99").fetchone()
            self.assertEqual(audit, (501, "2026-07-18T20:00:00+00:00"))
            meta = json.loads(conn.execute("SELECT json FROM film_meta WHERE id_tspdt=501").fetchone()[0])
            self.assertEqual(meta["id_tspdt"], 501)
            self.assertEqual(meta["poster"], "/img/poster/501")
            conn.close()

    def test_full_sync_reconciles_matches_and_preserves_unmatched_manual_films(self):
        with tempfile.TemporaryDirectory() as directory:
            conn = sync.connect(Path(directory) / "films.db")
            manual_values = (-99, "tt1234567", None, 99, 0, "Jane Director", "A Future Classic", "2026",
                             "UK", 100, None, "Drama", None, None, "manual:99", "2026-01-01", "2026-01-01", None)
            unmatched_values = (-100, "tt7654321", None, 100, 0, "Other Director", "Still Manual", "2025",
                                "FR", 90, None, "Comedy", None, None, "manual:100", "2026-01-01", "2026-01-01", None)
            conn.execute("INSERT INTO films VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", manual_values)
            conn.execute("INSERT INTO films VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", unmatched_values)
            conn.execute("INSERT INTO manual_films(tmdb_id,id_tspdt,imdb_id,title,year) VALUES(?,?,?,?,?)",
                         (99, -99, "tt1234567", "A Future Classic", "2026"))
            conn.execute("INSERT INTO manual_films(tmdb_id,id_tspdt,imdb_id,title,year) VALUES(?,?,?,?,?)",
                         (100, -100, "tt7654321", "Still Manual", "2025"))
            conn.commit()
            film = {
                "id_tspdt": 501, "imdb_id": "tt1234567", "imdb_url": "https://www.imdb.com/title/tt1234567/",
                "is_new": 1, "director": "Jane Director", "title": "Future Classic, A", "year": "2026",
                "country": "UK", "length_min": 100, "colour": "Col", "genre": "Drama", "content_hash": "official"
            }
            snapshot = {
                "films": [film], "rankings": [(501, "2026", 88)],
                "editions": [{"label": "2026", "poll_year": 2026, "poll_date": "2026-01-01"}],
                "notes": [], "duplicates": 0
            }
            stats = sync.sync(conn, snapshot, "test.xls", "abc", False)
            self.assertEqual(stats["reconciled"], 1)
            self.assertEqual(conn.execute("SELECT latest_rank FROM films WHERE id_tspdt=501").fetchone()[0], 88)
            self.assertEqual(conn.execute("SELECT removed_at FROM films WHERE id_tspdt=-100").fetchone()[0], None)
            self.assertEqual(conn.execute("SELECT reconciled FROM sync_runs").fetchone()[0], 1)
            conn.close()


if __name__ == "__main__":
    unittest.main()
