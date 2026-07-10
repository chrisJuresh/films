# tspdt

A film catalogue for the **They Shoot Pictures, Don't They?** rankings (the
aggregated "1,000 Greatest Films" poll) — ~26,500 films with their rank across
every published edition.

## What's here

- **`tspdt_sync.py`** — downloads the TSPDT *StartingList* and syncs it into a
  local SQLite database (`tspdt.db`), keyed on each film's stable `idTSPDT` so it
  handles new/removed/changed entries idempotently.
- **`site/`** — a SvelteKit web app to browse the catalogue: poster-grid,
  multi-select filters (decade, genre, country, colour), search, watchlist / seen
  tracking, and a per-film page with ranking history plus IMDb/TMDB metadata
  (poster art, cast, ratings, synopsis).

## Setup

1. Build the database:
   ```sh
   pip install -r requirements.txt
   python tspdt_sync.py
   ```
2. Add free API keys for poster art & ratings — copy `site/.env.example` to
   `site/.env` and fill in:
   - `TSPDT_TMDB_KEY` — https://www.themoviedb.org/settings/api
   - `TSPDT_OMDB_KEY` — http://www.omdbapi.com/apikey.aspx
3. Run the site:
   ```sh
   cd site
   npm install
   npm run dev        # http://localhost:5178
   ```

Data source: [They Shoot Pictures, Don't They?](https://theyshootpictures.com)
