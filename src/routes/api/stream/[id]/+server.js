import { error } from '@sveltejs/kit';
import { getFilmBasic } from '$lib/server/db.js';
import { getMovieFileInfo, RadarrError } from '$lib/server/radarr.js';
import { resolveSource, browserPlayable, encodedFile, encodedExists, fileResponse } from '$lib/server/media.js';
import { streamTranscode } from '$lib/server/transcode.js';

// Serve a film for the browser player. Prefers an encoded copy, then a directly
// playable source (both seekable via Range), otherwise transcodes on the fly.
export async function GET({ params, request }) {
  const id = Number(params.id);
  if (!(id > 0)) throw error(400, 'A valid film id is required.');
  const range = request.headers.get('range');

  if (encodedExists(id)) return fileResponse(encodedFile(id), range, {});

  const film = getFilmBasic(id);
  if (!film?.imdb_id) throw error(404, 'Film not found.');

  let mf;
  try { mf = await getMovieFileInfo(film.imdb_id); }
  catch (cause) { throw error(cause instanceof RadarrError ? cause.status : 502, cause?.message || 'Radarr error.'); }
  if (!mf) throw error(409, 'No downloaded file yet.');

  const src = resolveSource(mf.path);
  if (!src) throw error(422, 'Source file is not accessible to the server.');

  if (browserPlayable(mf)) return fileResponse(src, range, {});

  // On-the-fly iGPU transcode → fragmented MP4. Not seekable; killed on cancel.
  const proc = streamTranscode(src, { maxH: 720 });
  const body = new ReadableStream({
    start(controller) {
      proc.stdout.on('data', (c) => { controller.enqueue(c); if (controller.desiredSize <= 0) proc.stdout.pause(); });
      proc.stdout.on('end', () => { try { controller.close(); } catch { /* already closed */ } });
      proc.stdout.on('error', () => { try { controller.close(); } catch { /* already closed */ } });
    },
    pull() { proc.stdout.resume(); },
    cancel() { try { proc.kill('SIGKILL'); } catch { /* gone */ } }
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' } });
}
