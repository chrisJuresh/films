import assert from 'node:assert/strict';
import test from 'node:test';
import { downloadWithRadarrClient, RadarrError } from '../src/lib/server/radarrClient.js';

const settings = () => ({
  baseUrl: new URL('http://radarr:7878/radarr/'),
  apiKey: 'server-secret',
  rootFolderPath: '/movies',
  qualityProfileId: 4
});

const lookup = {
  title: 'Alien',
  year: 1979,
  tmdbId: 348,
  images: [],
  addOptions: { monitor: 'movieOnly' }
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function mockFetch(...responses) {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url: new URL(url), options });
    const response = responses.shift();
    if (!response) throw new Error('Unexpected fetch');
    return response;
  };
  return { calls, fetch };
}

test('adds a new movie and asks Radarr to search for it', async () => {
  const mock = mockFetch(
    jsonResponse(lookup),
    jsonResponse([]),
    jsonResponse({ id: 42, title: 'Alien' })
  );

  const result = await downloadWithRadarrClient('tt0078748', settings(), mock.fetch);

  assert.deepEqual(result, {
    status: 'queued', title: 'Alien', radarrId: 42, alreadyAdded: false
  });
  assert.equal(mock.calls.length, 3);
  assert.equal(mock.calls[0].url.pathname, '/radarr/api/v3/movie/lookup/imdb');
  assert.equal(mock.calls[0].url.searchParams.get('imdbId'), 'tt0078748');
  assert.equal(mock.calls[0].options.headers['X-Api-Key'], 'server-secret');
  assert.equal(mock.calls[2].url.pathname, '/radarr/api/v3/movie');
  assert.equal(mock.calls[2].options.method, 'POST');
  assert.deepEqual(JSON.parse(mock.calls[2].options.body), {
    ...lookup,
    qualityProfileId: 4,
    rootFolderPath: '/movies',
    monitored: true,
    minimumAvailability: 'released',
    addOptions: { monitor: 'movieOnly', searchForMovie: true }
  });
});

test('searches an existing movie that has no file', async () => {
  const mock = mockFetch(
    jsonResponse(lookup),
    jsonResponse([{ id: 7, title: 'Alien', hasFile: false }]),
    jsonResponse({ id: 91, name: 'MoviesSearch' })
  );

  const result = await downloadWithRadarrClient('tt0078748', settings(), mock.fetch);

  assert.equal(result.status, 'queued');
  assert.equal(result.alreadyAdded, true);
  assert.equal(mock.calls[2].url.pathname, '/radarr/api/v3/command');
  assert.deepEqual(JSON.parse(mock.calls[2].options.body), {
    name: 'MoviesSearch', movieIds: [7]
  });
});

test('does not start a search when Radarr already has the file', async () => {
  const mock = mockFetch(
    jsonResponse(lookup),
    jsonResponse([{ id: 7, title: 'Alien', hasFile: true }])
  );

  const result = await downloadWithRadarrClient('tt0078748', settings(), mock.fetch);

  assert.deepEqual(result, { status: 'available', title: 'Alien', radarrId: 7 });
  assert.equal(mock.calls.length, 2);
});

test('rejects a missing or malformed IMDb id before contacting Radarr', async () => {
  let called = false;
  await assert.rejects(
    downloadWithRadarrClient('', settings(), async () => { called = true; }),
    (error) => error instanceof RadarrError && error.status === 422
  );
  assert.equal(called, false);
});

test('maps authentication and malformed responses to safe errors', async () => {
  const auth = mockFetch(jsonResponse({}, 401));
  await assert.rejects(
    downloadWithRadarrClient('tt0078748', settings(), auth.fetch),
    (error) => error instanceof RadarrError
      && error.status === 502
      && error.message === 'Radarr rejected the configured API key.'
  );

  const malformed = mockFetch(new Response('not json', { status: 200 }));
  await assert.rejects(
    downloadWithRadarrClient('tt0078748', settings(), malformed.fetch),
    (error) => error instanceof RadarrError
      && error.message === 'Radarr returned an invalid response.'
  );
});

test('does not expose Radarr validation details to the browser-facing error', async () => {
  const mock = mockFetch(
    jsonResponse(lookup),
    jsonResponse([]),
    jsonResponse([{ errorMessage: 'Secret internal path: /mnt/private' }], 400)
  );

  await assert.rejects(
    downloadWithRadarrClient('tt0078748', settings(), mock.fetch),
    (error) => error instanceof RadarrError
      && error.status === 502
      && !error.message.includes('/mnt/private')
  );
});
