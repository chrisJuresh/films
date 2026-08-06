// Demo mode — the public, login-free build (demo.films.chrisj.uk).
//
// The private instance gets its identity from Cloudflare Access and drives a
// Radarr/qBittorrent/ffmpeg stack that only exists on the home server. Neither
// is true in public, so the demo differs in exactly two ways:
//
//   1. IDENTITY. There is no login, so each visitor gets an opaque random id in
//      a cookie and that becomes `locals.user`. Every per-user table is already
//      keyed on that column (user_status, lb_seen, lb_unmatched, playback), so
//      one visitor's watchlist is invisible to every other visitor with no
//      change to the data layer.
//   2. ACQUISITION IS ABSENT. Downloading, release picking and playback are not
//      hidden — the endpoints are refused outright (see hooks.server.js), so the
//      demo cannot reach a media stack even if a URL is typed by hand. "Watch"
//      becomes "where to watch legally" (TMDB/JustWatch availability).
//
// Anything that would let one visitor change what another sees is also refused:
// /api/manual-films writes to the shared catalogue, so it is off here.
import { env } from '$env/dynamic/private';

/** Public repo — the demo's own "the real thing lives here" link. */
export const GITHUB_URL = 'https://github.com/chrisJuresh/films';

// Read at call time (not module load) so the flag follows dynamic env.
export const isDemo = () => env.DEMO_MODE === '1';

/** Cookie holding the visitor's anonymous identity. */
export const SID_COOKIE = 'films_demo_sid';
const SID_MAX_AGE = 60 * 60 * 24 * 30;   // 30 days — long enough to come back to

/**
 * The visitor's identity for this request, minting one on first visit. Prefixed
 * so demo rows can never collide with a real Access email, and so a stray
 * `DEMO_MODE=1` on the private instance stays visibly separate.
 */
export function demoUser(cookies) {
  const existing = cookies.get(SID_COOKIE);
  if (existing && /^[0-9a-f]{32}$/.test(existing)) return 'demo:' + existing;

  const sid = crypto.randomUUID().replace(/-/g, '');
  cookies.set(SID_COOKIE, sid, {
    path: '/',
    httpOnly: true,        // never read from JS; the server is the only consumer
    sameSite: 'lax',
    maxAge: SID_MAX_AGE
    // `secure` is left to SvelteKit, which sets it for https and omits it for
    // localhost — so the loopback health check still works.
  });
  return 'demo:' + sid;
}

/**
 * Route prefixes that have no meaning without the home-server media stack, plus
 * the one endpoint that writes shared state. Refused with 404 rather than 403:
 * in the demo these features do not exist, so there is nothing to be forbidden.
 */
const OFF_IN_DEMO = [
  '/api/radarr',        // add/search/grab/cancel in Radarr
  '/api/grab-links',    // .torrent / magnet for a library file
  '/api/encode',        // iGPU SVT-AV1 encode jobs
  '/api/file',          // download the library file
  '/api/source',        // stream the untouched original (mpv)
  '/api/stream',        // in-browser VAAPI transcode
  '/api/watch',         // browser-playability probe
  '/api/playback',      // resume positions (nothing plays here)
  '/api/app-auth',      // hands the desktop app a CF Access service token
  '/api/manual-films',  // writes films/manual_films — shared across visitors
  '/downloads'          // the download tracker page
];

export const blockedInDemo = (pathname) =>
  OFF_IN_DEMO.some((p) => pathname === p || pathname.startsWith(p + '/'));
