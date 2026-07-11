import assert from 'node:assert/strict';
import test from 'node:test';
import { login, addTorrent, listTorrents, isComplete, QbError, torrentSource } from '../src/lib/server/qbittorrentClient.js';

test('torrentSource: real .torrent bytes upload; dead links/HTML never become a URL', () => {
  const torrent = Buffer.from('d8:announce35:http://tracker.example/announce...');   // bencode dict → starts with 'd'
  assert.deepEqual(torrentSource(torrent, null), { torrentFile: torrent });

  // A 500/HTML body (not bencode) with no magnet is unusable — must NOT be handed
  // to qB as a URL (that silently "adds" then never downloads).
  assert.equal(torrentSource(Buffer.from('<html>500</html>'), null), null);
  assert.equal(torrentSource(null, null), null);
  assert.equal(torrentSource(null, 'http://prowlarr/1/download?link=x'), null);   // http url is not a magnet

  // No usable bytes but a genuine magnet → add the magnet.
  assert.deepEqual(torrentSource(null, 'magnet:?xt=urn:btih:abc'), { url: 'magnet:?xt=urn:btih:abc' });
  // Valid bytes win even when a magnet is also present.
  assert.deepEqual(torrentSource(torrent, 'magnet:?xt=urn:btih:abc'), { torrentFile: torrent });
});

const settings = () => ({ baseUrl: new URL('http://qbittorrent:8081/'), username: 'u', password: 'p' });

function mockFetch(...responses) {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url: new URL(url), options });
    const r = responses.shift();
    if (!r) throw new Error('Unexpected fetch');
    return r;
  };
  return { calls, fetch };
}

test('login returns the SID cookie', async () => {
  const mock = mockFetch(new Response('Ok.', { status: 200, headers: { 'set-cookie': 'SID=abc123; HttpOnly; path=/' } }));
  const cookie = await login(settings(), mock.fetch);
  assert.equal(cookie, 'SID=abc123');
  assert.equal(mock.calls[0].url.pathname, '/api/v2/auth/login');
  assert.equal(mock.calls[0].options.method, 'POST');
});

test('login accepts a 204 + QBT_SID_<port> cookie (current qB)', async () => {
  const mock = mockFetch(new Response(null, { status: 204, headers: { 'set-cookie': 'QBT_SID_8081=abc+def; HttpOnly; path=/' } }));
  const cookie = await login(settings(), mock.fetch);
  assert.equal(cookie, 'QBT_SID_8081=abc+def');       // whole name=value, not just SID=
});

test('login rejects bad credentials', async () => {
  const mock = mockFetch(new Response('Fails.', { status: 200 }));
  await assert.rejects(login(settings(), mock.fetch), (e) => e instanceof QbError);
});

test('addTorrent accepts old "Ok.", qB5 pending JSON, and 409; rejects failures', async () => {
  const ok = mockFetch(new Response('Ok.', { status: 200 }));
  assert.equal(await addTorrent(settings(), { url: 'magnet:?x', category: 'films', tags: 'films-import,films-movie-7' }, 'SID=abc', ok.fetch), true);
  assert.equal(ok.calls[0].url.pathname, '/api/v2/torrents/add');
  assert.equal(ok.calls[0].options.method, 'POST');

  // qB 5.x: HTTP 202 + JSON, pending_count>0 means it took the URL (async fetch).
  const pending = mockFetch(new Response('{"added_torrent_ids":[],"failure_count":0,"pending_count":1,"success_count":0}', { status: 202, headers: { 'content-type': 'application/json' } }));
  assert.equal(await addTorrent(settings(), { url: 'http://x/t' }, 'SID=abc', pending.fetch), true);

  const dup = mockFetch(new Response('Conflict', { status: 409 }));
  assert.equal(await addTorrent(settings(), { url: 'http://x/t' }, 'SID=abc', dup.fetch), true);   // already added

  const badText = mockFetch(new Response('Fails.', { status: 200 }));
  await assert.rejects(addTorrent(settings(), { url: 'x' }, 'SID=abc', badText.fetch), (e) => e instanceof QbError);

  const badJson = mockFetch(new Response('{"failure_count":1,"pending_count":0,"success_count":0}', { status: 202 }));
  await assert.rejects(addTorrent(settings(), { url: 'x' }, 'SID=abc', badJson.fetch), (e) => e instanceof QbError);
});

test('listTorrents filters by tag and returns the array', async () => {
  const mock = mockFetch(new Response(
    JSON.stringify([{ hash: 'h', progress: 1, state: 'uploading', tags: 'films-import,films-movie-7', content_path: '/data/x' }]),
    { status: 200, headers: { 'content-type': 'application/json' } }
  ));
  const list = await listTorrents(settings(), { tag: 'films-import' }, 'SID=abc', mock.fetch);
  assert.equal(list.length, 1);
  assert.equal(mock.calls[0].url.searchParams.get('tag'), 'films-import');
});

test('isComplete recognises finished + seeding torrents', () => {
  assert.equal(isComplete({ progress: 1, state: 'stalledDL' }), true);
  assert.equal(isComplete({ progress: 0.5, state: 'downloading' }), false);
  assert.equal(isComplete({ progress: 0.9, state: 'stalledUP' }), true);
});
