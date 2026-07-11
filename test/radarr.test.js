import assert from 'node:assert/strict';
import test from 'node:test';
import { downloadWithRadarrClient, radarrStatus, searchReleases, grabRelease, pushRelease, manualImport, RadarrError } from '../src/lib/server/radarrClient.js';

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
    status: 'queued', title: 'Alien', radarrId: 42, alreadyAdded: false, yearMismatch: false
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

test('does not override Radarr\'s TMDB-owned year when adding a movie', async () => {
  const mock = mockFetch(
    jsonResponse(lookup),                       // TMDB year 1979
    jsonResponse([]),                           // not in library
    jsonResponse({ id: 42, title: 'Alien' })
  );

  // Our catalogue year (1975) differs, but Radarr owns the primary year (a PUT
  // is silently ignored — verified live), so we must not send an override.
  await downloadWithRadarrClient('tt0078748', settings(), mock.fetch, { year: '1975' });

  const body = JSON.parse(mock.calls[2].options.body);
  assert.equal(body.year, 1979);                // whatever the TMDB lookup returned
  assert.equal('secondaryYear' in body, false);
});

test('never PUTs to change an existing movie\'s year before searching', async () => {
  const mock = mockFetch(
    jsonResponse(lookup),                                          // TMDB 1979
    jsonResponse([{ id: 7, title: 'Alien', year: 1979, hasFile: false }]),
    jsonResponse({ id: 91, name: 'MoviesSearch' })
  );

  const result = await downloadWithRadarrClient('tt0078748', settings(), mock.fetch, { year: '1975' });

  assert.equal(result.alreadyAdded, true);
  assert.equal(mock.calls.length, 3);                             // lookup, movie?tmdbId, command
  assert.equal(mock.calls[2].url.pathname, '/radarr/api/v3/command');
  assert.equal(mock.calls.some((c) => c.options?.method === 'PUT'), false);
});

test('flags a catalogue/TMDB year mismatch (drives the Prowlarr fallback)', async () => {
  const mismatch = mockFetch(jsonResponse(lookup), jsonResponse([]), jsonResponse({ id: 42 }));
  const r1 = await downloadWithRadarrClient('tt0078748', settings(), mismatch.fetch, { year: '1975' });
  assert.equal(r1.yearMismatch, true);                    // lookup 1979 vs catalogue 1975

  const match = mockFetch(jsonResponse(lookup), jsonResponse([]), jsonResponse({ id: 42 }));
  const r2 = await downloadWithRadarrClient('tt0078748', settings(), match.fetch, { year: 1979 });
  assert.equal(r2.yearMismatch, false);
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

  assert.deepEqual(result, { status: 'available', title: 'Alien', radarrId: 7, yearMismatch: false });
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

test('searchReleases returns candidate releases (higher seeders first at equal score)', async () => {
  const mock = mockFetch(
    jsonResponse(lookup),                                    // lookup (year 1979)
    jsonResponse([{ id: 7, year: 1979, hasFile: false }]),   // movie?tmdbId
    jsonResponse([
      { guid: 'a', indexerId: 1, title: '720p x265', quality: { quality: { name: 'Bluray-720p' } }, size: 1e9, seeders: 5, customFormatScore: 0, rejected: false },
      { guid: 'b', indexerId: 2, title: '1080p x264', quality: { quality: { name: 'Bluray-1080p' } }, size: 8e9, seeders: 50, customFormatScore: 0, rejected: false }
    ])
  );
  const { releases } = await searchReleases('tt0078748', settings(), { year: 1979 }, mock.fetch);
  assert.equal(releases.length, 2);
  assert.equal(mock.calls[2].url.pathname, '/radarr/api/v3/release');
  assert.equal(mock.calls[2].url.searchParams.get('movieId'), '7');
  assert.equal(releases[0].title, '1080p x264');
});

test('grabRelease posts the chosen release guid + indexer', async () => {
  const mock = mockFetch(jsonResponse({}));
  const r = await grabRelease('abc', 3, settings(), mock.fetch);
  assert.equal(r.grabbed, true);
  assert.equal(mock.calls[0].url.pathname, '/radarr/api/v3/release');
  assert.equal(mock.calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(mock.calls[0].options.body), { guid: 'abc', indexerId: 3 });
});

test('pushRelease grabs when Radarr maps + approves the release', async () => {
  const mock = mockFetch(jsonResponse([{ approved: true, movie: { id: 42 } }]));
  const rel = { title: 'Alien 1979 1080p BluRay x264', downloadUrl: 'http://prowlarr/dl/abc',
    protocol: 'torrent', indexer: '1337x', publishDate: '2024-01-01T00:00:00Z' };
  const r = await pushRelease(rel, settings(), mock.fetch);
  assert.equal(r.grabbed, true);
  assert.equal(mock.calls[0].url.pathname, '/radarr/api/v3/release/push');
  assert.equal(mock.calls[0].options.method, 'POST');
  const body = JSON.parse(mock.calls[0].options.body);
  assert.equal(body.title, rel.title);
  assert.equal(body.downloadUrl, rel.downloadUrl);
  assert.equal(body.protocol, 'Torrent');            // normalised, capitalised
  assert.equal(body.publishDate, rel.publishDate);
  assert.equal(body.indexer, '1337x');
});

test('pushRelease fails loudly when Radarr can’t map the title to a movie', async () => {
  const mock = mockFetch(jsonResponse([{ approved: true, rejections: [] }]));   // no movie mapped
  await assert.rejects(
    pushRelease({ title: 'Jeanne Dielman 1080 Bruxelles 1975 1080p', downloadUrl: 'http://p/x', protocol: 'torrent' }, settings(), mock.fetch),
    (e) => e instanceof RadarrError && e.status === 422 && /match it to this film/.test(e.message)
  );
});

test('pushRelease falls back to the magnet link and rejects a linkless release', async () => {
  const mock = mockFetch(jsonResponse([{ approved: true, movie: { id: 1 } }]));
  await pushRelease({ title: 'X', magnetUrl: 'magnet:?xt=abc', protocol: 'usenet' }, settings(), mock.fetch);
  const body = JSON.parse(mock.calls[0].options.body);
  assert.equal(body.downloadUrl, 'magnet:?xt=abc');
  assert.equal(body.protocol, 'Usenet');
  await assert.rejects(
    pushRelease({ title: 'no link' }, settings(), async () => { throw new Error('should not fetch'); }),
    (e) => e instanceof RadarrError && e.status === 400
  );
});

test('manualImport force-imports the largest file into the given movie', async () => {
  const mock = mockFetch(
    jsonResponse([
      { path: '/data/torrents/x/sample.mkv', size: 1e7, quality: { quality: { name: 'Unknown' } }, languages: [{ id: 1, name: 'English' }] },
      { path: '/data/torrents/x/movie.mkv', size: 8e9, quality: { quality: { name: 'Bluray-1080p' } }, languages: [{ id: 2, name: 'French' }] }
    ]),
    jsonResponse({ id: 5, name: 'ManualImport' })
  );
  const r = await manualImport(18, '/data/torrents/x', settings(), mock.fetch);
  assert.equal(r.imported, '/data/torrents/x/movie.mkv');            // largest, not the sample
  assert.equal(mock.calls[0].url.pathname, '/radarr/api/v3/manualimport');
  assert.equal(mock.calls[0].url.searchParams.get('folder'), '/data/torrents/x');
  assert.equal(mock.calls[1].url.pathname, '/radarr/api/v3/command');
  const cmd = JSON.parse(mock.calls[1].options.body);
  assert.equal(cmd.name, 'ManualImport');
  assert.equal(cmd.importMode, 'copy');            // keep the torrent seeding
  assert.equal(cmd.files[0].movieId, 18);
  assert.equal(cmd.files[0].path, '/data/torrents/x/movie.mkv');
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
