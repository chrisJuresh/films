import assert from 'node:assert/strict';
import test from 'node:test';
import { login, addTorrent, listTorrents, isComplete, QbError } from '../src/lib/server/qbittorrentClient.js';

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

test('login rejects bad credentials', async () => {
  const mock = mockFetch(new Response('Fails.', { status: 200 }));
  await assert.rejects(login(settings(), mock.fetch), (e) => e instanceof QbError);
});

test('addTorrent posts to torrents/add and reports a refusal', async () => {
  const ok = mockFetch(new Response('Ok.', { status: 200 }));
  const r = await addTorrent(settings(), { url: 'magnet:?x', category: 'films', tags: 'films-import,films-movie-7' }, 'SID=abc', ok.fetch);
  assert.equal(r, true);
  assert.equal(ok.calls[0].url.pathname, '/api/v2/torrents/add');
  assert.equal(ok.calls[0].options.method, 'POST');

  const bad = mockFetch(new Response('Fails.', { status: 200 }));
  await assert.rejects(addTorrent(settings(), { url: 'x' }, 'SID=abc', bad.fetch), (e) => e instanceof QbError);
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
