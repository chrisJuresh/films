import { error } from '@sveltejs/kit';
import { getFilmBasic } from '$lib/server/db.js';
import { torrentFor } from '$lib/server/radarr.js';

// Stream a .torrent for this film (best Prowlarr release). The Prowlarr download
// URL — which carries the API key — is fetched server-side; only the .torrent
// bytes reach the browser.
export async function GET({ params }) {
  const id = Number(params.id);
  const film = id > 0 ? getFilmBasic(id) : null;
  if (!film?.imdb_id) throw error(404, 'Film not found.');
  const bytes = await torrentFor(film.imdb_id, film.year, film.title);
  if (!bytes) throw error(404, 'No .torrent available for this film.');
  return new Response(bytes, {
    headers: {
      'Content-Type': 'application/x-bittorrent',
      'Content-Disposition': `attachment; filename="film-${id}.torrent"`
    }
  });
}
