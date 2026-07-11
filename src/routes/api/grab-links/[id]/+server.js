import { json, error } from '@sveltejs/kit';
import { getFilmBasic } from '$lib/server/db.js';
import { serverTorrentsFor } from '$lib/server/radarr.js';

// The film's actual torrent(s) on the server (qBittorrent): [{ hash, name, magnet }].
// For the in-library Download menu. Best-effort — [] if qB is off/unreachable.
export async function GET({ params }) {
  const id = Number(params.id);
  const film = id > 0 ? getFilmBasic(id) : null;
  if (!film?.imdb_id) throw error(404, 'Film not found.');
  try {
    return json({ torrents: await serverTorrentsFor(film.imdb_id) });
  } catch {
    return json({ torrents: [] });
  }
}
