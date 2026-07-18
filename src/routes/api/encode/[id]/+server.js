import { json, error } from '@sveltejs/kit';
import { getFilmBasic } from '$lib/server/db.js';
import { getMovieFileInfo, RadarrError } from '$lib/server/radarr.js';
import { resolveSource, encodedFile, ffprobeInfo, ensureEncodeDir } from '$lib/server/media.js';
import { startEncode, encodeJob } from '$lib/server/transcode.js';

// GET: current encode job status. POST: start an iGPU encode to a saved copy.
export function GET({ params }) {
  const id = Number(params.id);
  const job = encodeJob(id);
  return json(job ? { state: job.state, percent: job.percent, error: job.error } : { state: 'idle', percent: 0 });
}

export async function POST({ params }) {
  const id = Number(params.id);
  if (!Number.isSafeInteger(id) || id === 0) throw error(400, 'A valid film id is required.');
  const running = encodeJob(id);
  if (running && running.state === 'running') return json({ state: 'running', percent: running.percent });

  const film = getFilmBasic(id);
  if (!film?.imdb_id) throw error(404, 'Film not found.');

  let mf;
  try { mf = await getMovieFileInfo(film.imdb_id); }
  catch (cause) { throw error(cause instanceof RadarrError ? cause.status : 502, cause?.message || 'Radarr error.'); }
  if (!mf) throw error(409, 'No downloaded file to encode yet.');

  const src = resolveSource(mf.path);
  if (!src) throw error(422, 'Source file is not accessible to the server — check the media mount.');

  ensureEncodeDir();
  const info = await ffprobeInfo(src);
  const job = startEncode(id, src, encodedFile(id), info);
  return json({ state: job.state, percent: job.percent });
}
