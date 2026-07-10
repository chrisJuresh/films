// iGPU (VAAPI) transcoding. Two modes:
//   * startEncode() — transcode a source to a saved MP4, tracking progress.
//   * streamTranscode() — transcode on the fly to a fragmented MP4 piped to the
//     HTTP response, for "watch in browser" without waiting for a full encode.
// Decode is on the CPU (works for any input codec) and the expensive ENCODE runs
// on the iGPU via h264_vaapi.
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { VAAPI_DEVICE } from './media.js';

const jobs = new Map();                                   // film id -> encode job (in-memory)
export function encodeJob(id) { return jobs.get(id) || null; }

const vf = (maxH) => `scale=-2:'min(${maxH},ih)',format=nv12,hwupload`;

export function startEncode(id, src, out, duration, quality = '1080') {
  const existing = jobs.get(id);
  if (existing && existing.state === 'running') return existing;
  try { mkdirSync(dirname(out), { recursive: true }); } catch { /* best-effort */ }

  const job = { state: 'running', percent: 0, out, error: null };
  jobs.set(id, job);

  const args = [
    '-hide_banner', '-nostdin', '-y',
    '-vaapi_device', VAAPI_DEVICE,
    '-i', src,
    '-vf', vf(quality === '720' ? 720 : 1080),
    '-c:v', 'h264_vaapi', '-qp', '23',
    '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
    '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats',
    out
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
  p.on('error', (e) => { job.state = 'error'; job.error = e.message; });
  p.on('close', (code) => {
    if (code === 0) { job.state = 'done'; job.percent = 100; }
    else if (job.state !== 'error') { job.state = 'error'; job.error = (errTail.trim().split('\n').pop() || `ffmpeg exited ${code}`); }
  });
  return job;
}

/** On-the-fly transcode to a fragmented MP4 stream. Returns the child process;
 *  the caller pipes .stdout to the HTTP response and kills it on disconnect. */
export function streamTranscode(src, { maxH = 720 } = {}) {
  const args = [
    '-hide_banner', '-nostdin',
    '-vaapi_device', VAAPI_DEVICE,
    '-i', src,
    '-vf', vf(maxH),
    '-c:v', 'h264_vaapi', '-qp', '24',
    '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
    '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    'pipe:1'
  ];
  return spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] });
}
