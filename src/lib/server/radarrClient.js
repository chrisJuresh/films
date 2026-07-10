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
  if (malformed) throw new RadarrError('Radarr returned an invalid response.', 502);
  return body ?? {};                          // empty body (e.g. DELETE) is fine
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

  // Radarr SEARCHES indexers using the movie's PRIMARY year, which comes from
  // TMDB and can differ from the year releases are actually tagged with (e.g.
  // TMDB 1976 vs the 1975 our catalogue and the indexers use — secondaryYear
  // only affects matching, not the search term). So when they differ we make
  // Radarr search OUR year and keep TMDB's as secondaryYear, so it searches the
  // year the release sites use yet still matches releases tagged with either.
  const tmdbYear = lookup.year;
  const catYear = Number.parseInt(hints.year, 10);
  const useAlt = Number.isInteger(catYear) && catYear !== tmdbYear;

  const existing = await requestRadarr(settings, `movie?tmdbId=${lookup.tmdbId}`, {}, fetchImpl);
  const movie = Array.isArray(existing) ? existing[0] : null;

  if (movie?.hasFile) {
    return { status: 'available', title: movie.title || lookup.title, radarrId: movie.id };
  }

  if (movie?.id) {
    // Point an already-added movie's search at our year. Radarr searches
    // indexers with the movie's primary year, so this must land BEFORE the
    // search. Use the full movie resource (the list form can be rejected by
    // PUT) and only proceed to search once it's applied.
    if (useAlt && movie.year !== catYear) {
      const full = await requestRadarr(settings, `movie/${movie.id}`, {}, fetchImpl);
      await requestRadarr(settings, `movie/${movie.id}`,
        { method: 'PUT', body: { ...full, year: catYear, secondaryYear: tmdbYear } }, fetchImpl);
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
      ...(useAlt ? { year: catYear, secondaryYear: tmdbYear } : {}),
      qualityProfileId: settings.qualityProfileId,
      rootFolderPath: settings.rootFolderPath,
      monitored: true,
      minimumAvailability: 'released',
      addOptions: { ...(lookup.addOptions || {}), searchForMovie: true }
    }
  }, fetchImpl);

  return { status: 'queued', title: added?.title || lookup.title, radarrId: added?.id, alreadyAdded: false };
}

/** Cancel any in-progress download for a film (removes it from Radarr's queue
 *  and the download client). For "I changed my mind after clicking Download." */
export async function cancelDownload(imdbId, settings, fetchImpl = globalThis.fetch) {
  if (!/^tt\d{7,10}$/i.test(imdbId || '')) return { removed: 0 };
  const lookup = await requestRadarr(settings, `movie/lookup/imdb?imdbId=${encodeURIComponent(imdbId)}`, {}, fetchImpl);
  if (!lookup?.tmdbId) return { removed: 0 };
  const existing = await requestRadarr(settings, `movie?tmdbId=${lookup.tmdbId}`, {}, fetchImpl);
  const movie = Array.isArray(existing) ? existing[0] : null;
  if (!movie?.id) return { removed: 0 };
  const q = await requestRadarr(settings, `queue/details?movieIds=${movie.id}`, {}, fetchImpl);
  const items = Array.isArray(q) ? q.filter((x) => x.movieId === movie.id) : [];
  let removed = 0;
  for (const it of items) {
    await requestRadarr(settings, `queue/${it.id}?removeFromClient=true&blocklist=false`, { method: 'DELETE' }, fetchImpl);
    removed++;
  }
  return { removed };
}

/** Bulk map of imdbId -> download state across the whole Radarr library, for
 *  the sidebar filter. 'downloaded' | 'downloading' | 'error'. */
export async function libraryState(settings, fetchImpl = globalThis.fetch) {
  const movies = await requestRadarr(settings, 'movie', {}, fetchImpl);
  const list = Array.isArray(movies) ? movies : [];
  const byId = new Map();
  const state = new Map();
  for (const m of list) {
    byId.set(m.id, m);
    if (!m.imdbId) continue;
    if (m.hasFile) state.set(m.imdbId, 'downloaded');
    else if (m.monitored) state.set(m.imdbId, 'wanted');       // in Radarr, monitored, no file yet
  }
  try {
    const q = await requestRadarr(settings, 'queue/details', {}, fetchImpl);
    for (const it of (Array.isArray(q) ? q : [])) {
      const m = byId.get(it.movieId);
      if (!m?.imdbId) continue;
      const errored = it.trackedDownloadStatus === 'error' || it.trackedDownloadStatus === 'warning';
      if (errored) state.set(m.imdbId, 'error');
      else if (state.get(m.imdbId) !== 'downloaded') state.set(m.imdbId, 'downloading');
    }
  } catch { /* queue optional */ }
  return state;
}

/** Interactive search: ensure the film is in Radarr (added monitored, no auto-
 *  search, with our year), then return the candidate releases so the user can
 *  pick one instead of letting Radarr auto-grab. */
export async function searchReleases(imdbId, settings, hints = {}, fetchImpl = globalThis.fetch) {
  if (!/^tt\d{7,10}$/i.test(imdbId || '')) throw new RadarrError('This film has no usable IMDb ID.', 422);
  const lookup = await requestRadarr(settings, `movie/lookup/imdb?imdbId=${encodeURIComponent(imdbId)}`, {}, fetchImpl);
  if (!lookup?.tmdbId) throw new RadarrError('Radarr could not find this film.', 422);
  const tmdbYear = lookup.year;
  const catYear = Number.parseInt(hints.year, 10);
  const useAlt = Number.isInteger(catYear) && catYear !== tmdbYear;

  const existing = await requestRadarr(settings, `movie?tmdbId=${lookup.tmdbId}`, {}, fetchImpl);
  let movie = Array.isArray(existing) ? existing[0] : null;
  if (!movie?.id) {
    movie = await requestRadarr(settings, 'movie', { method: 'POST', body: {
      ...lookup, ...(useAlt ? { year: catYear, secondaryYear: tmdbYear } : {}),
      qualityProfileId: settings.qualityProfileId, rootFolderPath: settings.rootFolderPath,
      monitored: true, minimumAvailability: 'released', addOptions: { ...(lookup.addOptions || {}), searchForMovie: false }
    } }, fetchImpl);
  } else if (useAlt && movie.year !== catYear) {
    const full = await requestRadarr(settings, `movie/${movie.id}`, {}, fetchImpl);
    movie = await requestRadarr(settings, `movie/${movie.id}`, { method: 'PUT', body: { ...full, year: catYear, secondaryYear: tmdbYear } }, fetchImpl);
  }

  const rel = await requestRadarr(settings, `release?movieId=${movie.id}`, {}, fetchImpl);
  const releases = (Array.isArray(rel) ? rel : []).map((r) => ({
    guid: r.guid, indexerId: r.indexerId, indexer: r.indexer || null, protocol: r.protocol || null,
    title: r.title, quality: r.quality?.quality?.name || null,
    size: Number(r.size) || null, seeders: r.seeders ?? null,
    languages: (r.languages || []).map((l) => l.name).filter(Boolean),
    score: r.customFormatScore ?? 0, rejected: !!r.rejected, rejections: r.rejections || []
  })).sort((a, b) => (b.score - a.score) || ((b.seeders || 0) - (a.seeders || 0)));
  return { releases: releases.slice(0, 50) };
}

/** Grab a specific release the user chose. */
export async function grabRelease(guid, indexerId, settings, fetchImpl = globalThis.fetch) {
  if (!guid || indexerId == null) throw new RadarrError('A release id is required.', 400);
  await requestRadarr(settings, 'release', { method: 'POST', body: { guid, indexerId } }, fetchImpl);
  return { grabbed: true };
}

/** Server-side only: the film's actual file path + codecs (for transcoding).
 *  Never sent to the browser. Returns null if Radarr has no file. */
export async function movieFileInfo(imdbId, settings, fetchImpl = globalThis.fetch) {
  if (!/^tt\d{7,10}$/i.test(imdbId || '')) return null;
  const lookup = await requestRadarr(settings, `movie/lookup/imdb?imdbId=${encodeURIComponent(imdbId)}`, {}, fetchImpl);
  if (!lookup?.tmdbId) return null;
  const existing = await requestRadarr(settings, `movie?tmdbId=${lookup.tmdbId}`, {}, fetchImpl);
  const mf = (Array.isArray(existing) ? existing[0] : null)?.movieFile;
  if (!mf?.path) return null;
  return {
    path: mf.path,
    videoCodec: mf.mediaInfo?.videoCodec || null,
    audioCodec: mf.mediaInfo?.audioCodec || null,
    size: Number(mf.size) || null
  };
}

/**
 * Read Radarr's live view of a film: whether it's added, its download progress,
 * the quality/size it fetched, and any errors. Everything is best-effort — a
 * failure of any single call degrades gracefully rather than throwing.
 */
export async function radarrStatus(imdbId, settings, fetchImpl = globalThis.fetch) {
  if (!/^tt\d{7,10}$/i.test(imdbId || '')) return { present: false };

  const lookup = await requestRadarr(settings, `movie/lookup/imdb?imdbId=${encodeURIComponent(imdbId)}`, {}, fetchImpl);
  if (!lookup?.tmdbId) return { present: false };

  const existing = await requestRadarr(settings, `movie?tmdbId=${lookup.tmdbId}`, {}, fetchImpl);
  const movie = Array.isArray(existing) ? existing[0] : null;
  if (!movie?.id) return { present: false };

  let queue = null;
  try {
    const q = await requestRadarr(settings, `queue/details?movieIds=${movie.id}`, {}, fetchImpl);
    // Filter strictly to THIS movie — no fallback to q[0], which would show
    // another film's download here.
    const item = Array.isArray(q) ? q.find((x) => x.movieId === movie.id) : null;
    if (item) {
      const size = Number(item.size) || 0;
      const left = Number(item.sizeleft ?? 0);
      const msgs = (item.statusMessages || []).flatMap((m) => m.messages || []);
      queue = {
        progress: size > 0 ? Math.max(0, Math.min(100, Math.round((1 - left / size) * 100))) : null,
        state: item.trackedDownloadState || item.status || null,   // downloading | importPending | ...
        health: item.trackedDownloadStatus || null,                // ok | warning | error
        timeleft: item.timeleft && item.timeleft !== '00:00:00' ? item.timeleft : null,
        quality: item.quality?.quality?.name || null,
        protocol: item.protocol || null,                           // torrent | usenet
        indexer: item.indexer || null,
        client: item.downloadClient || null,
        error: item.errorMessage || (msgs.length ? msgs.join('; ') : null)
      };
    }
  } catch { /* queue read is optional */ }

  const mf = movie.movieFile;
  return {
    present: true,
    monitored: !!movie.monitored,
    hasFile: !!movie.hasFile,
    movieStatus: movie.status || null,                             // announced | inCinemas | released
    quality: mf?.quality?.quality?.name || null,
    resolution: mf?.mediaInfo?.resolution || null,
    videoCodec: mf?.mediaInfo?.videoCodec || null,
    audioChannels: mf?.mediaInfo?.audioChannels || null,
    audioCodec: mf?.mediaInfo?.audioCodec || null,
    releaseGroup: mf?.releaseGroup || null,
    sizeOnDisk: Number(movie.sizeOnDisk) || Number(mf?.size) || null,
    queue
  };
}
