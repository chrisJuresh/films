import { json } from '@sveltejs/kit';
import { getFilmBasic } from '$lib/server/db.js';
import { getMovieFileInfo, RadarrError } from '$lib/server/radarr.js';
import { resolveSource, browserPlayable, encodedExists } from '$lib/server/media.js';
import { encodeJob } from '$lib/server/transcode.js';

// What "watch" options are available for this film, for the film-page UI:
//   hasFile        – a source file is on disk and reachable by the server
//   sourcePlayable – the source can play in a browser <video> as-is
//   encoded        – an iGPU-encoded browser-friendly copy already exists
//   browser        – can be watched in-browser now (encoded || sourcePlayable)
//   encode         – current encode job {state, percent, error} or null
export async function GET({ params }) {
  const id = Number(params.id);
  const job = encodeJob(id);
  const out = {
    hasFile: false, sourcePlayable: false, encoded: id > 0 ? encodedExists(id) : false,
    browser: false, encode: job ? { state: job.state, percent: job.percent, error: job.error } : null
  };
  const film = id > 0 ? getFilmBasic(id) : null;
  if (film?.imdb_id) {
    try {
      const mf = await getMovieFileInfo(film.imdb_id);
      if (mf) {
        out.hasFile = !!resolveSource(mf.path);
        out.sourcePlayable = out.hasFile && browserPlayable(mf);
      }
    } catch (e) { if (!(e instanceof RadarrError)) throw e; }   // unconfigured/unreachable → defaults
  }
  out.browser = out.encoded || out.sourcePlayable;
  return json(out);
}
