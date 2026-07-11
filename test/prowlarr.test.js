import assert from 'node:assert/strict';
import test from 'node:test';
import { prowlarrSearch, ProwlarrError } from '../src/lib/server/prowlarrClient.js';

const settings = () => ({ baseUrl: new URL('http://prowlarr:9696/prowlarr/'), apiKey: 'pk' });

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

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

test('prowlarrSearch queries movies by title+year and maps releases (seeders desc)', async () => {
  const mock = mockFetch(jsonResponse([
    { guid: 'a', indexerId: 1, indexer: '1337x', protocol: 'torrent', title: 'Jeanne Dielman 1975 720p', size: 1e9, seeders: 3, downloadUrl: 'http://p/a' },
    { guid: 'b', indexerId: 2, indexer: 'RARBG', protocol: 'torrent', title: 'Jeanne Dielman 1975 1080p BluRay', size: 8e9, seeders: 40, magnetUrl: 'magnet:?b' }
  ]));

  const out = await prowlarrSearch(settings(), 'Jeanne Dielman', 1975, mock.fetch);

  assert.equal(out.length, 2);
  assert.match(out[0].title, /1080p/);              // higher seeders first
  assert.equal(out[0].quality, '1080p');
  assert.equal(out[0].source, 'prowlarr');
  assert.equal(out[0].magnetUrl, 'magnet:?b');

  const u = mock.calls[0].url;
  assert.equal(u.pathname, '/prowlarr/api/v1/search');
  assert.equal(u.searchParams.get('query'), 'Jeanne Dielman 1975');
  assert.equal(u.searchParams.get('type'), 'search');
  assert.equal(u.searchParams.get('categories'), '2000');
  assert.equal(mock.calls[0].options.headers['X-Api-Key'], 'pk');
});

test('prowlarrSearch maps an auth failure to a ProwlarrError', async () => {
  const mock = mockFetch(new Response('', { status: 401 }));
  await assert.rejects(
    prowlarrSearch(settings(), 'x', 2000, mock.fetch),
    (e) => e instanceof ProwlarrError && e.status === 502
  );
});

test('prowlarrSearch returns [] for an empty query without calling Prowlarr', async () => {
  let called = false;
  const out = await prowlarrSearch(settings(), '', '', async () => { called = true; });
  assert.deepEqual(out, []);
  assert.equal(called, false);
});
