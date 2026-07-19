import { error } from '@sveltejs/kit';
import { getFilmBasic } from '$lib/server/db.js';
import { getMovieFileInfo, RadarrError } from '$lib/server/radarr.js';
import { resolveSource, fileResponse, encodedFile, encodedExists } from '$lib/server/media.js';

// Serve the film to a NATIVE player (mpv, via the desktop app) INLINE and at the
// BEST quality: the original source file (mpv decodes any codec/resolution, so no
// lossy re-encode is needed — better than any transcode on a good display). Falls
// back to the encoded copy only if the original isn't reachable.
export async function GET({ params, request }) {
  const id = Number(params.id);
  if (!Number.isSafeInteger(id) || id === 0) throw error(400, 'A valid film id is required.');
  const film = getFilmBasic(id);
  if (film?.imdb_id) {
    try {
      const mf = await getMovieFileInfo(film.imdb_id);
      const src = mf && resolveSource(mf.path);
      if (src) return fileResponse(src, request.headers.get('range'), {});
    } catch (cause) { if (!(cause instanceof RadarrError)) throw cause; }
  }
  if (encodedExists(id)) return fileResponse(encodedFile(id), request.headers.get('range'), {});
  throw error(409, 'No playable file yet.');
}
