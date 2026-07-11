import { error } from '@sveltejs/kit';
import { basename, extname } from 'node:path';
import { getFilmBasic } from '$lib/server/db.js';
import { getMovieFileInfo, RadarrError } from '$lib/server/radarr.js';
import { resolveSource, fileResponse, encodedFile, encodedExists } from '$lib/server/media.js';

// Download the film to the user's device (range-capable so it can resume).
// Prefers the iGPU-encoded copy (the "best encode" — browser-friendly, tuned
// for the display); falls back to the original library file.
export async function GET({ params, request }) {
  const id = Number(params.id);
  if (!(id > 0)) throw error(400, 'A valid film id is required.');

  if (encodedExists(id)) {
    return fileResponse(encodedFile(id), request.headers.get('range'), { type: 'application/octet-stream', downloadName: `film-${id}.mp4` });
  }

  const film = getFilmBasic(id);
  if (!film?.imdb_id) throw error(404, 'Film not found.');

  let mf;
  try { mf = await getMovieFileInfo(film.imdb_id); }
  catch (cause) { throw error(cause instanceof RadarrError ? cause.status : 502, cause?.message || 'Radarr error.'); }
  if (!mf) throw error(409, 'No downloaded file yet.');

  const src = resolveSource(mf.path);
  if (!src) throw error(422, 'Source file is not accessible to the server — check the media mount.');

  const name = basename(mf.path) || `film-${id}${extname(mf.path) || '.mkv'}`;
  return fileResponse(src, request.headers.get('range'), { type: 'application/octet-stream', downloadName: name });
}
