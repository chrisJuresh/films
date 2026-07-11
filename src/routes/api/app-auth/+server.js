import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

// Hands the desktop app a Cloudflare Access service token so mpv / the downloader
// can authenticate. This endpoint is itself behind CF Access, so only the
// logged-in user ever receives it; the token lives in server env, never in the
// installer. Returns nulls when not configured (then the app falls back to the
// session cookie).
export function GET() {
  return json({
    cfId: env.CF_ACCESS_CLIENT_ID?.trim() || null,
    cfSecret: env.CF_ACCESS_CLIENT_SECRET?.trim() || null
  });
}
