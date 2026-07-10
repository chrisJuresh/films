const REQUEST_TIMEOUT_MS = 20_000;

export class RadarrError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'RadarrError';
    this.status = status;
  }
}

async function requestRadarr(settings, path, options = {}, fetchImpl = globalThis.fetch) {
  const url = new URL(`api/v3/${path.replace(/^\/+/, '')}`, settings.baseUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  let body = null;
  let malformed = false;
  try {
    response = await fetchImpl(url, {
      method: options.method || 'GET',
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'X-Api-Key': settings.apiKey,
        ...(options.body ? { 'content-type': 'application/json' } : {})
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {})
    });
    const text = await response.text();
    if (text) {
      try { body = JSON.parse(text); } catch { malformed = true; }
    }
  } catch (cause) {
    if (cause instanceof RadarrError) throw cause;
    if (cause?.name === 'AbortError') {
      throw new RadarrError('Radarr did not respond in time.', 504);
    }
    throw new RadarrError('Could not connect to Radarr.', 502);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new RadarrError('Radarr rejected the configured API key.', 502);
    }
    if (response.status === 404 && path.startsWith('movie/lookup/')) {
      throw new RadarrError('Radarr could not find this film from its IMDb ID.', 422);
    }
    if ([400, 422].includes(response.status)) {
      throw new RadarrError('Radarr rejected the request. Check its root folder and quality profile settings.', 502);
    }
    throw new RadarrError(`Radarr returned HTTP ${response.status}.`, 502);
  }
  if (malformed || body === null) throw new RadarrError('Radarr returned an invalid response.', 502);
  return body;
}

/**
 * Ensure a film is in Radarr and ask Radarr to find a release for it.
 * Returns `available` when Radarr already has a file and `queued` otherwise.
 */
export async function downloadWithRadarrClient(imdbId, settings, fetchImpl = globalThis.fetch, hints = {}) {
  if (!/^tt\d{7,10}$/i.test(imdbId || '')) {
    throw new RadarrError('This film has no usable IMDb ID for Radarr.', 422);
  }

  const lookup = await requestRadarr(
    settings,
    `movie/lookup/imdb?imdbId=${encodeURIComponent(imdbId)}`,
    {},
    fetchImpl
  );
  if (!lookup?.tmdbId) {
    throw new RadarrError('Radarr could not find this film from its IMDb ID.', 422);
  }

  // Radarr keys releases off TMDB's year, which can differ from the year scene
  // releases are actually tagged with (e.g. TMDB 1976 vs the 1975 our catalogue
  // and the indexers use). Passing our year as Radarr's secondaryYear lets it
  // match releases tagged with EITHER year, without overriding TMDB's primary.
  const wantYear = Number.parseInt(hints.year, 10);
  const altYear = Number.isInteger(wantYear) && wantYear !== lookup.year ? wantYear : null;

  const existing = await requestRadarr(settings, `movie?tmdbId=${lookup.tmdbId}`, {}, fetchImpl);
  const movie = Array.isArray(existing) ? existing[0] : null;

  if (movie?.hasFile) {
    return { status: 'available', title: movie.title || lookup.title, radarrId: movie.id };
  }

  if (movie?.id) {
    // Widen an already-added movie's matching to our year too (best-effort — a
    // failure here must not block the search).
    if (altYear && movie.secondaryYear !== altYear && movie.year !== altYear) {
      try {
        await requestRadarr(settings, `movie/${movie.id}`,
          { method: 'PUT', body: { ...movie, secondaryYear: altYear } }, fetchImpl);
      } catch { /* non-fatal */ }
    }
    await requestRadarr(settings, 'command', {
      method: 'POST',
      body: { name: 'MoviesSearch', movieIds: [movie.id] }
    }, fetchImpl);
    return { status: 'queued', title: movie.title || lookup.title, radarrId: movie.id, alreadyAdded: true };
  }

  const added = await requestRadarr(settings, 'movie', {
    method: 'POST',
    body: {
      ...lookup,
      ...(altYear ? { secondaryYear: altYear } : {}),
      qualityProfileId: settings.qualityProfileId,
      rootFolderPath: settings.rootFolderPath,
      monitored: true,
      minimumAvailability: 'released',
      addOptions: { ...(lookup.addOptions || {}), searchForMovie: true }
    }
  }, fetchImpl);

  return { status: 'queued', title: added?.title || lookup.title, radarrId: added?.id, alreadyAdded: false };
}
