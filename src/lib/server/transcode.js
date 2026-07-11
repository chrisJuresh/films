// iGPU (VAAPI) transcoding. Two modes:
//   * startEncode() — transcode a source to a saved MP4, tracking progress.
//   * streamTranscode() — transcode on the fly to a fragmented MP4 piped to the
//     HTTP response, for "watch in browser" without waiting for a full encode.
// Decode is on the CPU (works for any input codec) and the expensive ENCODE runs
// on the iGPU via h264_vaapi.
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { VAAPI_DEVICE } from './media.js';

const jobs = new Map();                                   // film id -> encode job (in-memory)
export function encodeJob(id) { return jobs.get(id) || null; }

const vf = (maxH) => `scale=-2:'min(${maxH},ih)',format=nv12,hwupload`;

export function startEncode(id, src, out, info = {}) {
  const existing = jobs.get(id);
  if (existing && existing.state === 'running') return existing;
  try { mkdirSync(dirname(out), { recursive: true }); } catch { /* best-effort */ }

  // Encode to a temp file and only rename to the final (served) path on success.
  // An interrupted/failed encode (killed, container restart) then never leaves a
  // broken MP4 that the stream endpoint would serve instead of a live transcode.
  const part = `${out}.part`;
  try { rmSync(part, { force: true }); } catch { /* best-effort */ }
  const done = () => { try { rmSync(part, { force: true }); } catch { /* gone */ } };

  const job = { state: 'running', percent: 0, out, error: null };
  jobs.set(id, job);
  const duration = info.duration || 0;

  // A compact, modern, web-optimised copy for the BROWSER fallback + downloads
  // (the desktop app plays the MASTER via mpv, so it needs no encode). SVT-AV1
  // 10-bit, RF 20, preset 5, capped to the panel's native 2560x1440 (never
  // upscaled), output SDR Rec.709. HDR sources are tone-mapped to SDR.
  const box = "scale='min(2560,iw)':'min(1440,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2";
  const filters = info.hdr
    ? `zscale=t=linear:npl=100,tonemap=tonemap=hable:desat=0,zscale=p=bt709:t=bt709:m=bt709:r=tv,${box},format=yuv420p10le,setsar=1`
    : `${box},format=yuv420p10le,setsar=1`;
  // AAC 5.1 @ 640k for surround sources; else stereo @ 256k.
  const audio = (info.channels || 2) > 2
    ? ['-c:a', 'aac', '-ac', '6', '-b:a', '640k']
    : ['-c:a', 'aac', '-ac', '2', '-b:a', '256k'];

  const args = [
    '-hide_banner', '-nostdin', '-y',
    '-i', src,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', filters,
    '-c:v', 'libsvtav1', '-crf', '20', '-preset', '5', '-pix_fmt', 'yuv420p10le',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    ...audio,
    '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats',
    part
  ];
  const p = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '', errTail = '';
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      const m = line.match(/^out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (m && duration > 0) {
        const secs = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
        job.percent = Math.max(0, Math.min(99, Math.round((secs / duration) * 100)));
      }
    }
  });
  p.stderr.on('data', (d) => { errTail = (errTail + d).slice(-600); });
  p.on('error', (e) => { job.state = 'error'; job.error = e.message; done(); });
  p.on('close', (code) => {
    if (code === 0) {
      try { renameSync(part, out); job.state = 'done'; job.percent = 100; }
      catch (e) { job.state = 'error'; job.error = `Could not finalise the encode: ${e.message}`; done(); }
    } else if (job.state !== 'error') {
      job.state = 'error';
      job.error = (errTail.trim().split('\n').pop() || `ffmpeg exited ${code}`);
      done();
    }
  });
  return job;
}

/** On-the-fly transcode to a fragmented MP4 stream. Returns the child process;
 *  the caller pipes .stdout to the HTTP response and kills it on disconnect. */
export function streamTranscode(src, { maxH = 1080 } = {}) {
  const args = [
    '-hide_banner', '-nostdin',
    '-vaapi_device', VAAPI_DEVICE,
    '-i', src,
    '-vf', vf(maxH),
    '-c:v', 'h264_vaapi', '-profile:v', 'high', '-qp', '22',
    '-c:a', 'aac', '-b:a', '192k', '-ac', '2',
    '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    'pipe:1'
  ];
  return spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] });
}
