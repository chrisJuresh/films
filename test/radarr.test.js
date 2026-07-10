import assert from 'node:assert/strict';
import test from 'node:test';
import { downloadWithRadarrClient, radarrStatus, RadarrError } from '../src/lib/server/radarrClient.js';

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

test('adds the catalogue year as secondaryYear when it differs from TMDB', async () => {
  const mock = mockFetch(
    jsonResponse(lookup),                       // TMDB year 1979
    jsonResponse([]),
    jsonResponse({ id: 42, title: 'Alien' })
  );

  await downloadWithRadarrClient('tt0078748', settings(), mock.fetch, { year: '1975' });

  const body = JSON.parse(mock.calls[2].options.body);
  assert.equal(body.secondaryYear, 1975);       // widen matching to our year
  assert.equal(body.year, 1979);                // TMDB primary year untouched
});

test('omits secondaryYear when the catalogue year matches TMDB', async () => {
  const mock = mockFetch(
    jsonResponse(lookup),
    jsonResponse([]),
    jsonResponse({ id: 42, title: 'Alien' })
  );

  await downloadWithRadarrClient('tt0078748', settings(), mock.fetch, { year: 1979 });

  assert.equal('secondaryYear' in JSON.parse(mock.calls[2].options.body), false);
});

test('widens an already-added movie to the catalogue year, then searches', async () => {
  const mock = mockFetch(
    jsonResponse(lookup),
    jsonResponse([{ id: 7, title: 'Alien', year: 1979, hasFile: false }]),
    jsonResponse({ id: 7, title: 'Alien', year: 1979, secondaryYear: 1975 }),   // PUT
    jsonResponse({ id: 91, name: 'MoviesSearch' })                              // command
  );

  const result = await downloadWithRadarrClient('tt0078748', settings(), mock.fetch, { year: '1975' });

  assert.equal(result.alreadyAdded, true);
  assert.equal(mock.calls[2].options.method, 'PUT');
  assert.equal(mock.calls[2].url.pathname, '/radarr/api/v3/movie/7');
  assert.equal(JSON.parse(mock.calls[2].options.body).secondaryYear, 1975);
  assert.equal(mock.calls[3].url.pathname, '/radarr/api/v3/command');
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

test('radarrStatus reports download progress and quality', async () => {
  const mock = mockFetch(
    jsonResponse({ tmdbId: 348, title: 'Alien' }),
    jsonResponse([{ id: 7, hasFile: false, monitored: true }]),
    jsonResponse([{ movieId: 7, size: 1000, sizeleft: 250, quality: { quality: { name: 'Bluray-1080p' } }, trackedDownloadState: 'downloading', timeleft: '00:12:00' }])
  );
  const s = await radarrStatus('tt0078748', settings(), mock.fetch);
  assert.equal(s.present, true);
  assert.equal(s.hasFile, false);
  assert.equal(s.queue.progress, 75);
  assert.equal(s.queue.quality, 'Bluray-1080p');
  assert.equal(s.queue.state, 'downloading');
});

test('radarrStatus reports a downloaded file with its quality', async () => {
  const mock = mockFetch(
    jsonResponse({ tmdbId: 348 }),
    jsonResponse([{ id: 7, hasFile: true, monitored: true, sizeOnDisk: 8000000000,
      movieFile: { quality: { quality: { name: 'Bluray-1080p' } }, mediaInfo: { resolution: '1920x1080', videoCodec: 'x265' } } }]),
    jsonResponse([])
  );
  const s = await radarrStatus('tt0078748', settings(), mock.fetch);
  assert.equal(s.present, true);
  assert.equal(s.hasFile, true);
  assert.equal(s.quality, 'Bluray-1080p');
  assert.equal(s.resolution, '1920x1080');
  assert.equal(s.queue, null);
});

test('radarrStatus returns not-present for a film Radarr does not have', async () => {
  const mock = mockFetch(jsonResponse({ tmdbId: 348 }), jsonResponse([]));
  const s = await radarrStatus('tt0078748', settings(), mock.fetch);
  assert.deepEqual(s, { present: false });
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
