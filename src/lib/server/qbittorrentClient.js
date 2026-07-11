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

/** Add a torrent by URL or magnet, with a category + tags. */
export async function addTorrent(settings, { url, category, tags }, cookie, fetchImpl = globalThis.fetch) {
  const fd = new FormData();
  fd.append('urls', url);
  if (category) fd.append('category', category);
  if (tags) fd.append('tags', tags);
  fd.append('paused', 'false');
  const res = await fetchImpl(new URL('api/v2/torrents/add', settings.baseUrl), {
    method: 'POST', headers: { Cookie: cookie, Referer: ref(settings) }, body: fd
  });
  const text = await res.text().catch(() => '');
  if (res.status !== 200 || /fail/i.test(text)) throw new QbError(`qBittorrent refused the torrent (HTTP ${res.status}).`);
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
