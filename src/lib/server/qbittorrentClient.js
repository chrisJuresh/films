// qBittorrent WebUI API (v2) client. Used only as the last-resort path for
// releases Radarr cannot grab itself — specifically films whose title defeats
// Radarr's parser (e.g. "…1080 Bruxelles…"), so release/push approves but can't
// map to a movie. We add the torrent straight to qB, then force-import the
// finished file into Radarr by movie id (see radarr.js). Pure-ish: settings +
// fetch are injectable for tests.

export class QbError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'QbError';
    this.status = status;
  }
}

const ref = (s) => s.baseUrl.origin;   // qB checks Referer against its own address

/** Log in and return the `SID=…` cookie string to pass to other calls. */
export async function login(settings, fetchImpl = globalThis.fetch) {
  let res;
  try {
    res = await fetchImpl(new URL('api/v2/auth/login', settings.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', Referer: ref(settings) },
      body: new URLSearchParams({ username: settings.username, password: settings.password })
    });
  } catch { throw new QbError('Could not reach qBittorrent.'); }
  if (res.status === 403) throw new QbError('qBittorrent temporarily banned this client (too many failed logins).');
  const text = await res.text().catch(() => '');
  if (/fail/i.test(text)) throw new QbError('qBittorrent rejected the credentials.');
  // Success is HTTP 200 ("Ok.") on older builds or 204 (empty) on current ones —
  // the real signal is the session cookie, whose name is QBT_SID_<port> now (was
  // SID). Return the whole name=value so callers send the right Cookie header.
  const set = res.headers.getSetCookie?.() || [];
  const raw = set.length ? set.join('\n') : (res.headers.get('set-cookie') || '');
  const m = /(QBT_SID[^=;\s]*|SID)=([^;]+)/.exec(raw);
  if (!m) throw new QbError('qBittorrent did not return a session cookie.');
  return `${m[1]}=${m[2]}`;
}

/** Best-effort: make sure a category exists (qB also auto-creates on add). */
export async function createCategory(settings, name, cookie, fetchImpl = globalThis.fetch) {
  try {
    await fetchImpl(new URL('api/v2/torrents/createCategory', settings.baseUrl), {
      method: 'POST',
      headers: { Cookie: cookie, 'content-type': 'application/x-www-form-urlencoded', Referer: ref(settings) },
      body: new URLSearchParams({ category: name })
    });
  } catch { /* already exists / not fatal */ }
}

// Decide what to hand qB from a fetched download body + a possible magnet.
// A real .torrent is a bencoded dict — its first byte is 'd' (0x64). Anything
// else (an indexer proxy 500, an HTML error page) is NOT uploaded, and a plain
// http(s) URL is NEVER used as a fallback: qB fetches URLs asynchronously and
// silently drops failures, so a dead link looks "added" but never downloads.
// Only a genuine magnet: link is an acceptable URL fallback. null => unusable.
export function torrentSource(buf, magnet) {
  if (buf && buf.length > 20 && buf[0] === 0x64) return { torrentFile: buf };
  if (typeof magnet === 'string' && /^magnet:/i.test(magnet)) return { url: magnet };
  return null;
}

/** Add a torrent, with a category + tags. Prefer uploading the .torrent bytes
 *  (synchronous, reliable) over handing qB a URL (qB fetches URLs asynchronously,
 *  which can silently fail to materialise). Falls back to a URL/magnet. */
export async function addTorrent(settings, { url, torrentFile, filename, category, tags }, cookie, fetchImpl = globalThis.fetch) {
  const fd = new FormData();
  if (torrentFile) fd.append('torrents', new Blob([torrentFile], { type: 'application/x-bittorrent' }), filename || 'film.torrent');
  else fd.append('urls', url);
  if (category) fd.append('category', category);
  if (tags) fd.append('tags', tags);
  const res = await fetchImpl(new URL('api/v2/torrents/add', settings.baseUrl), {
    method: 'POST', headers: { Cookie: cookie, Referer: ref(settings) }, body: fd
  });
  if (res.status === 409) return true;                                   // already added
  const text = (await res.text().catch(() => '')).trim();
  if (res.status < 200 || res.status >= 300) throw new QbError(`qBittorrent refused the torrent (HTTP ${res.status}).`);
  if (/^fails\.?$/i.test(text)) throw new QbError('qBittorrent could not add the torrent.');   // older qB
  // qB 5.x returns JSON counts (HTTP 202). Only a pure failure means nothing was
  // accepted or queued; success_count/pending_count > 0 both mean it took it.
  if (text.startsWith('{')) {
    try {
      const j = JSON.parse(text);
      if ((j.success_count ?? 0) === 0 && (j.pending_count ?? 0) === 0 && (j.failure_count ?? 0) > 0)
        throw new QbError('qBittorrent rejected the torrent link.');
    } catch (e) { if (e instanceof QbError) throw e; }
  }
  return true;
}

/** List torrents, optionally filtered by category and/or tag. */
export async function listTorrents(settings, { category, tag } = {}, cookie, fetchImpl = globalThis.fetch) {
  const u = new URL('api/v2/torrents/info', settings.baseUrl);
  if (category) u.searchParams.set('category', category);
  if (tag) u.searchParams.set('tag', tag);
  const res = await fetchImpl(u, { headers: { Cookie: cookie, Referer: ref(settings) } });
  if (res.status !== 200) throw new QbError(`qBittorrent list failed (HTTP ${res.status}).`);
  const body = await res.json().catch(() => null);
  return Array.isArray(body) ? body : [];
}

/** Add or remove tags on torrents (hashes: string or array). */
export async function setTags(settings, hashes, tags, add, cookie, fetchImpl = globalThis.fetch) {
  const endpoint = add ? 'addTags' : 'removeTags';
  const res = await fetchImpl(new URL(`api/v2/torrents/${endpoint}`, settings.baseUrl), {
    method: 'POST',
    headers: { Cookie: cookie, 'content-type': 'application/x-www-form-urlencoded', Referer: ref(settings) },
    body: new URLSearchParams({ hashes: Array.isArray(hashes) ? hashes.join('|') : hashes, tags })
  });
  return res.status === 200;
}

// qB states that mean the download is finished (seeding/complete).
export const DONE_STATES = new Set(['uploading', 'stalledUP', 'pausedUP', 'forcedUP', 'queuedUP', 'checkingUP']);
export function isComplete(t) { return (t?.progress ?? 0) >= 1 || DONE_STATES.has(t?.state); }
