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

export function startEncode(id, src, out, duration, quality = '1080') {
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

  // Tuned for a colour-calibrated Dell S3220DGF (1440p, SDR/sRGB, 8-bit, HDR off):
  //   - cap at the panel's native 1440p, never upscale (upscaling only bloats size;
  //     the GPU upscales 1080p→1440p at playback just as well)
  //   - H.264 High profile, 8-bit 4:2:0 (nv12) BT.709 — exactly what an SDR sRGB
  //     display wants, and universally browser-playable
  //   - QP 18: visually transparent for VAAPI H.264 (quality over file size)
  //   - AAC 192k stereo
  const maxH = quality === '720' ? 720 : quality === '1080' ? 1080 : 1440;
  const args = [
    '-hide_banner', '-nostdin', '-y',
    '-vaapi_device', VAAPI_DEVICE,
    '-i', src,
    '-vf', vf(maxH),
    '-c:v', 'h264_vaapi', '-profile:v', 'high', '-qp', '18',
    '-c:a', 'aac', '-b:a', '192k', '-ac', '2',
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
