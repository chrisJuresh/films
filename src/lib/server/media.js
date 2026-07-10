// Local media helpers: turn a Radarr file path into a path THIS container can
// read, decide whether a browser can play a file directly, and locate encoded
// copies. Pure Node (no SvelteKit deps) so it's testable standalone.
import { existsSync, mkdirSync, statSync, createReadStream } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';

const ROOTS = (process.env.MEDIA_ROOTS || '/mnt/bay1/media,/mnt/bay2/media,/mnt/bay4/media')
  .split(',').map((s) => s.trim()).filter(Boolean);
const RADARR_PREFIX = process.env.RADARR_MEDIA_PREFIX || '/data/media';
export const ENCODE_DIR = process.env.ENCODE_DIR || '/data/encoded';
export const VAAPI_DEVICE = process.env.VAAPI_DEVICE || '/dev/dri/renderD128';

/** Map a Radarr file path to a path readable in this container, or null.
 *  Tries the path as-is (identical mount), then each configured media root. */
export function resolveSource(radarrPath) {
  if (!radarrPath) return null;
  if (existsSync(radarrPath)) return radarrPath;
  const rel = radarrPath.startsWith(RADARR_PREFIX) ? radarrPath.slice(RADARR_PREFIX.length) : radarrPath;
  for (const root of ROOTS) {
    const p = join(root, rel);
    if (existsSync(p)) return p;
  }
  return null;
}

const CONTAINER_OK = /\.(mp4|m4v|webm|mov)$/i;
const VIDEO_OK = /^(h264|avc|x264|avc1|vp8|vp9|av1|hevc? ?\(?\)?)/i;   // hevc plays only in Safari; be conservative below
const VIDEO_SAFE = /^(h264|avc|x264|avc1|vp8|vp9|av1)/i;
const AUDIO_OK = /^(aac|mp3|opus|vorbis)/i;

/** Can a browser <video> play this file directly, with no transcode? */
export function browserPlayable(file) {
  if (!file?.path || !CONTAINER_OK.test(file.path)) return false;
  const v = String(file.videoCodec || '');
  const a = String(file.audioCodec || '');
  return VIDEO_SAFE.test(v) && (!a || AUDIO_OK.test(a));
}

export function encodedFile(id) { return join(ENCODE_DIR, `${id}.mp4`); }
export function encodedExists(id) { return existsSync(encodedFile(id)); }
export function ensureEncodeDir() { try { mkdirSync(ENCODE_DIR, { recursive: true }); } catch { /* best-effort */ } }

/** Serve a file with HTTP Range support (so <video> can seek). */
export function fileResponse(path, rangeHeader, { type = 'video/mp4', downloadName = null } = {}) {
  const size = statSync(path).size;
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes' };
  if (downloadName) headers['Content-Disposition'] = `attachment; filename="${downloadName.replace(/"/g, '')}"`;
  let start = 0, end = size - 1, status = 200;
  const m = /^bytes=(\d*)-(\d*)/.exec(rangeHeader || '');
  if (m && (m[1] || m[2])) {
    start = m[1] ? parseInt(m[1], 10) : 0;
    end = m[2] ? parseInt(m[2], 10) : size - 1;
    if (!Number.isFinite(start) || start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    end = Math.min(end, size - 1);
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = String(end - start + 1);
  return new Response(Readable.toWeb(createReadStream(path, { start, end })), { status, headers });
}

/** Duration in seconds (for encode progress %), or null. */
export function ffprobeDuration(path) {
  return new Promise((resolve) => {
    let out = '';
    try {
      const p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nk=1:nw=1', path]);
      p.stdout.on('data', (d) => (out += d));
      p.on('close', () => { const n = parseFloat(out.trim()); resolve(Number.isFinite(n) ? n : null); });
      p.on('error', () => resolve(null));
    } catch { resolve(null); }
  });
}
