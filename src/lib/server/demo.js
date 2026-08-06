// Demo mode — the public, login-free build (demo.films.chrisj.uk).
//
// The private instance gets its identity from Cloudflare Access and drives a
// Radarr/qBittorrent/ffmpeg stack that only exists on the home server. Neither
// is true in public, so the demo differs in exactly three ways:
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
//   3. SHARED STATE IS READ-ONLY. Per-user rows are per-visitor and safe, but
//      the catalogue is common ground, so nothing here may write it. "Add film"
//      is kept — dialog, TMDB search and all — with its final Add disabled and
//      saying why, and /api/manual-films refusing POST behind that (403).
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
 * Route prefixes that have no meaning without the home-server media stack.
 * Refused with 404 rather than 403: in the demo these features do not exist, so
 * there is nothing to be forbidden.
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
  '/downloads'          // the download tracker page
];

/**
 * Routes the demo may READ but not write. The Add-film dialog is kept — it is
 * worth showing — so its TMDB search still answers, but the final "Add" is
 * refused: a manual film is a row in the SHARED catalogue (films, manual_films,
 * film_meta), not a per-visitor row like a watchlist entry, so one visitor's
 * addition would change what every other visitor sees. The dialog greys the
 * button out and says so; this is the other half, so a hand-made POST is refused
 * too. 403, not 404 — the route is here, the write is not allowed.
 */
const READ_ONLY_IN_DEMO = ['/api/manual-films'];
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const covers = (prefixes, pathname) =>
  prefixes.some((p) => pathname === p || pathname.startsWith(p + '/'));

/** The refusal this request earns in demo mode, or null to let it through. */
export function demoRefusal(pathname, method) {
  if (covers(OFF_IN_DEMO, pathname)) {
    return { status: 404, message: 'Not available in the demo' };
  }
  if (covers(READ_ONLY_IN_DEMO, pathname) && !READ_METHODS.has(method)) {
    return {
      status: 403,
      message: 'The demo is read-only: a new film would join the catalogue every visitor sees.'
    };
  }
  return null;
}

// The demo's TMDB search is public and unauthenticated, so the endpoint is also
// a proxy onto this deployment's TMDB key. A token bucket per visitor leaves a
// person typing (the client debounces at 280ms) well clear of the limit while
// keeping a script from spending the quota.
const SEARCH_BURST = 20;
const SEARCH_REFILL_MS = 1500;    // sustained: one search every 1.5s
const IDLE_MS = 10 * 60 * 1000;
const buckets = new Map();

/** Consume one search token for `user`; false when the bucket is empty. */
export function demoSearchAllowed(user) {
  const now = Date.now();
  // Buckets are per anonymous cookie and the map is process-local, so sweep the
  // stale ones rather than growing one entry per visitor for the process's life.
  if (buckets.size > 1000) {
    for (const [key, b] of buckets) if (now - b.at > IDLE_MS) buckets.delete(key);
  }
  const bucket = buckets.get(user) || { tokens: SEARCH_BURST, at: now };
  bucket.tokens = Math.min(SEARCH_BURST, bucket.tokens + (now - bucket.at) / SEARCH_REFILL_MS);
  bucket.at = now;
  buckets.set(user, bucket);
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}
