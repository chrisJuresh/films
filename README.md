# films

A film catalogue for the **They Shoot Pictures, Don't They?** rankings (the
aggregated "1,000 Greatest Films" poll) — ~26,500 films with their rank across
every published edition. Lives at **https://films.chrisj.uk**.

## Layout

- **repo root** — a SvelteKit web app (`src/`, `static/`, `svelte.config.js`, …)
  to browse the catalogue: poster-grid, multi-select filters (decade, genre,
  country, colour), search, per-user watchlist / seen tracking, and a per-film
  page with ranking history plus IMDb/TMDB metadata (poster art, cast, ratings).
- **`sync/`** — the data pipeline. `tspdt_sync.py` downloads the TSPDT
  *StartingList* and syncs it into a local SQLite database (`tspdt.db`), keyed on
  each film's stable `idTSPDT` so it handles new/removed/changed entries
  idempotently. ("tspdt" here is the data source, not the project name.)
- **`deploy/`** — production deployment (Docker + Cloudflare tunnel). See
  [deploy/README.md](deploy/README.md).

## Local development

1. Build the database:
   ```sh
   python3 -m venv .venv
   .venv/bin/pip install -r sync/requirements.txt
   .venv/bin/python sync/tspdt_sync.py        # writes ./tspdt.db
   ```
2. (optional) API keys for poster art & ratings — copy `.env.example` to `.env`:
   - `TSPDT_TMDB_KEY` — https://www.themoviedb.org/settings/api
   - `TSPDT_OMDB_KEY` — http://www.omdbapi.com/apikey.aspx
3. (optional) Connect the film-page **Download** button to Radarr by setting all
   four `RADARR_*` values documented in `.env.example`. The root folder must be
   the path as Radarr sees it, and the quality profile is its numeric id.
4. Run the site:
   ```sh
   npm install
   npm run dev        # http://localhost:5178
   ```

Data source: [They Shoot Pictures, Don't They?](https://theyshootpictures.com)
