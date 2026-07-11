<script>
  import { onMount } from 'svelte';
  import Poster from '$lib/components/Poster.svelte';
  import Sparkline from '$lib/components/Sparkline.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import { displayTitle, gradientFor, colourLabel } from '$lib/util.js';
  import { counts, toast } from '$lib/stores.js';

  let isTauri = $state(false);        // running inside the Tauri desktop app?
  let playerInfo = $state(null);      // { os, arch, mpv } from the desktop app
  let hideNudge = $state(true);       // hide the "get the app" nudge (until we know)
  onMount(() => {
    const t = window.__TAURI__;
    if (t?.core?.invoke) {
      isTauri = true;
      t.core.invoke('player_info').then((i) => { playerInfo = i; }).catch(() => {});
    } else {
      hideNudge = localStorage.getItem('films-hide-app-nudge') === '1';
    }
  });
  function dismissNudge() { hideNudge = true; try { localStorage.setItem('films-hide-app-nudge', '1'); } catch { /* ignore */ } }

  let { data } = $props();
  let film = $derived(data.film);

  let status = $state(data.film.status ?? null);      // site status: watchlist | seen | null
  let lbState = $state(data.film.lb_state ?? null);   // letterboxd: watched | unwatched | null
  let meta = $state(null);    // IMDb/TMDB enrichment
  let downloadState = $state('idle'); // idle | loading | queued | available
  let radarr = $state(null);          // live Radarr status (added? progress? quality? errors?)
  let radarrTimer;
  let watchInfo = $state(null);       // /api/watch: browser-playable? encoded? encode job?
  let watchTimer;
  let playing = $state(false);        // inline browser player open
  let videoEl;
  let savedAt = 0;
  let pbCleared = $state(false);      // user reset watch progress
  let certsOpen = $state(false);      // age-rating breakdown expanded
  let releases = $state(null);        // interactive-search candidates (pick a release)
  let releasesLoading = $state(false);
  let grabbing = $state(null);        // guid of the release currently being grabbed
  let cancelling = $state(false);
  let releasesFallback = $state(false); // results came from the Prowlarr year-fallback
  let sortBy = $state('quality');     // release sort: 'quality' | 'seeders' | 'size'
  let watchMenu = $state(false);      // Watch split-button dropdown open?
  let splitEl;                        // the watch split container (for click-away)
  let dlMenu = $state(false);         // Download split-button dropdown open?
  let dlSplitEl;
  let grabLinks = $state(null);       // { magnet, hasTorrent } for in-library download

  // Resolution rank so we can sort/mark quality across Radarr ("Bluray-1080p")
  // and Prowlarr ("1080p") naming alike.
  function qRank(q) {
    const s = (q || '').toLowerCase();
    if (s.includes('2160') || s.includes('4k') || s.includes('uhd')) return 4;
    if (s.includes('1080')) return 3;
    if (s.includes('720')) return 2;
    if (s.includes('480') || s.includes('dvd') || s.includes(' sd')) return 1;
    return 0;
  }
  let sortedReleases = $derived.by(() => {
    const arr = [...(releases || [])];
    const seed = (a, b) => (b.seeders || 0) - (a.seeders || 0);
    const qual = (a, b) => qRank(b.quality) - qRank(a.quality);
    if (sortBy === 'seeders') arr.sort((a, b) => seed(a, b) || qual(a, b));
    else if (sortBy === 'size') arr.sort((a, b) => (b.size || 0) - (a.size || 0) || qual(a, b));
    else arr.sort((a, b) => qual(a, b) || ((b.score || 0) - (a.score || 0)) || seed(a, b));
    return arr;
  });
  // Approximates what Radarr's auto-grab ("Download") would pick: the best
  // non-rejected release by quality, then custom-format score, then seeders.
  let autoPickGuid = $derived.by(() => {
    const ok = (releases || []).filter((r) => !r.rejected);
    if (!ok.length) return null;
    return [...ok].sort((a, b) =>
      (qRank(b.quality) - qRank(a.quality)) || ((b.score || 0) - (a.score || 0)) || ((b.seeders || 0) - (a.seeders || 0))
    )[0]?.guid || null;
  });

  let loadedId;
  $effect(() => {
    const id = film.id_tspdt;
    status = film.status ?? null; lbState = film.lb_state ?? null;
    if (loadedId === id) return;
    loadedId = id; meta = null; downloadState = 'idle'; radarr = null;
    watchInfo = null; playing = false; savedAt = 0; releases = null; releasesLoading = false;
    grabbing = null; cancelling = false; releasesFallback = false; sortBy = 'quality'; watchMenu = false;
    dlMenu = false; grabLinks = null; pbCleared = false; certsOpen = false;
    clearTimeout(radarrTimer); clearTimeout(watchTimer);
    loadRadarr(id); loadWatch(id);
    fetch(`/api/meta/${id}`).then((r) => r.json())
      .then((mm) => { if (loadedId === id) meta = mm; }).catch(() => { if (loadedId === id) meta = { enabled: false }; });
  });

  let ready = $derived(meta && meta.enabled !== false);
  let watchlisted = $derived(status === 'watchlist');
  let lbWatched = $derived(lbState === 'watched');
  let seen = $derived(status === 'seen' || lbWatched);
  let rewatch = $derived(status === 'rewatch');
  let unfinished = $derived(status === 'unfinished');
  // Something is playable now → Watch is the primary action; otherwise Download /
  // Choose release are the coloured (actionable) ones.
  let watchable = $derived(!!(watchInfo?.hasFile || watchInfo?.encoded));
  let downloadLabel = $derived(
    downloadState === 'loading' ? 'Sending…' :
    downloadState === 'queued' ? 'Requested' :
    downloadState === 'available' ? 'In library' : 'Download'
  );
  let downloadIcon = $derived(downloadState === 'queued' || downloadState === 'available' ? 'check' : 'download');
  // Age ratings: freshest from live enrichment, else the queryable film_cert set.
  let certs = $derived((ready && meta?.certifications?.length) ? meta.certifications : (film.certs || []));
  // Show one representative rating (prefer GB, then US); the rest expand on demand.
  let primaryCert = $derived(certs.find((c) => c.country === 'GB') || certs.find((c) => c.country === 'US') || certs[0] || null);

  // Watch: in the Tauri desktop app, open natively (mpv, else the OS default);
  // in a plain browser, play in-browser via the iGPU stream.
  function watchFilm() {
    if (!(watchInfo?.hasFile || watchInfo?.encoded)) {
      const msg = radarr?.hasFile ? 'Downloaded in Radarr, but this server can’t reach the file yet (media mount).'
        : radarr?.queue ? 'Still downloading — not ready to watch yet.'
        : radarr?.present ? 'In Radarr, but not downloaded yet — start a search or pick a release.'
        : 'Not in the library yet — hit Download first.';
      toast(msg, 'info', 4200);
      return;
    }
    openInPlayer();   // default: native (mpv) under Tauri, else in-browser
  }
  // Open in the native player (Tauri → mpv/OS default) or fall back to browser.
  function openInPlayer() {
    const t = typeof window !== 'undefined' ? window.__TAURI__ : null;
    if (t?.core?.invoke) {
      // Native player gets the ORIGINAL file (best quality — no lossy re-encode).
      const url = new URL(`/api/source/${film.id_tspdt}`, window.location.origin).href;
      t.core.invoke('open_in_player', { url, title: displayTitle(film.title) })
        .then((used) => toast(`Opening in ${used || 'your player'}…`, 'ok'))
        .catch((e) => toast('Could not open the player: ' + e, 'error', 4600));
      return;
    }
    openPlayer();
  }
  // The specific "watch this way" options behind the Watch button's caret.
  let watchOptions = $derived.by(() => {
    const o = [];
    if (!watchInfo || !(watchInfo.hasFile || watchInfo.encoded)) return o;
    if (isTauri) o.push({ label: playerInfo?.mpv ? 'Open in mpv' : 'Open in default player', act: openInPlayer });
    if (watchInfo.browser) o.push({ label: watchInfo.encoded ? 'Play encoded copy (browser)' : 'Play in browser', act: openPlayer });
    else if (watchInfo.hasFile) o.push({ label: 'Stream in browser · iGPU transcode', act: openPlayer });
    if (watchInfo.hasFile && !watchInfo.encoded && watchInfo.encode?.state !== 'running')
      o.push({ label: 'Encode a browser copy · iGPU', act: startEncode });
    if (watchInfo.encoded) o.push({ label: 'Download encoded copy', href: `/api/encode/${film.id_tspdt}/download` });
    return o;
  });
  function pickWatch(o) { watchMenu = false; if (o.act) o.act(); }
  async function openDlMenu() {
    dlMenu = !dlMenu;
    if (dlMenu && !grabLinks) {
      try { grabLinks = await (await fetch(`/api/grab-links/${film.id_tspdt}`)).json(); }
      catch { grabLinks = { torrents: [] }; }
    }
  }
  const shortName = (n) => { const s = (n || '').replace(/\.(mkv|mp4|avi)$/i, ''); return s.length > 26 ? s.slice(0, 25) + '…' : s; };

  // The Download button's state — reflects requested/downloading/importing even
  // when the grab wasn't Radarr's top pick (e.g. a qB-direct grab). "Choose
  // release" stays enabled as the manual override.
  let dlBtn = $derived.by(() => {
    if (downloadState === 'loading') return { label: 'Sending…', disabled: true, icon: 'sync', spin: true };
    if (radarr?.queue) {
      const p = radarr.queue.progress;
      const importing = radarr.queue.state === 'importPending' || radarr.queue.state === 'importing';
      return { label: importing ? 'Importing…' : `Downloading${p != null ? ' ' + p + '%' : ''}…`, disabled: true, icon: 'sync', spin: true };
    }
    if (radarr?.qb) return { label: radarr.qb.done ? 'Importing…' : `Downloading ${radarr.qb.progress}%…`, disabled: true, icon: 'sync', spin: true };
    if ((radarr?.present && radarr?.monitored) || downloadState === 'queued') return { label: 'Requested…', disabled: true, icon: 'check', spin: false };
    return { label: 'Download', disabled: false, icon: 'download', spin: false };
  });
  async function downloadFilm() {
    if (downloadState !== 'idle') return;
    downloadState = 'loading';
    try {
      const response = await fetch(`/api/radarr/${film.id_tspdt}`, { method: 'POST' });
      let result = {};
      try { result = await response.json(); } catch { /* Use the fallback message below. */ }
      if (!response.ok) throw new Error(result.message || 'Radarr could not start this download.');

      const title = result.title || displayTitle(film.title);
      downloadState = result.status === 'available' ? 'available' : 'queued';
      if (downloadState === 'available') {
        toast(`“${title}” is already downloaded in Radarr.`, 'info', 4200);
      } else if (result.via === 'qbittorrent') {
        toast(`Radarr couldn’t match “${title}”, so it’s downloading via qBittorrent — it’ll import automatically when done.`, 'ok', 7000);
      } else if (result.via === 'prowlarr') {
        toast(`Radarr couldn’t find “${title}” on its year — grabbed a Prowlarr release instead.`, 'ok', 5400);
      } else if (result.grabFailed) {
        toast(`Found ${result.prowlarrFound} Prowlarr release(s) for “${title}”, but Radarr couldn’t auto-grab: ${result.grabFailed}`, 'error', 9000);
      } else if (result.alreadyAdded) {
        toast(`Radarr is searching for “${title}”.`, 'ok', 4200);
      } else {
        toast(`Added “${title}” to Radarr and started a search.`, 'ok', 4200);
      }
      loadRadarr(film.id_tspdt); loadWatch(film.id_tspdt);
    } catch (cause) {
      downloadState = 'idle';
      toast(cause?.message || 'Could not connect to Radarr.', 'error', 4800);
    }
  }
  async function cancelDownload() {
    if (cancelling) return;
    cancelling = true;
    try {
      const r = await fetch(`/api/radarr/${film.id_tspdt}`, { method: 'DELETE' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.message || 'Could not cancel.');
      toast(d.removed ? 'Download cancelled.' : 'Nothing to cancel.', 'ok');
      downloadState = 'idle';
      loadRadarr(film.id_tspdt);
    } catch (e) { toast(e.message || 'Could not cancel the download.', 'error', 4200); }
    finally { cancelling = false; }
  }
  // Interactive search: let the user pick a release instead of Radarr auto-grab.
  async function chooseRelease() {
    releasesLoading = true; releases = null;
    try {
      const r = await fetch(`/api/radarr/${film.id_tspdt}/releases`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.message || 'Release search failed.');
      releases = d.releases || [];
      releasesFallback = !!d.fallback;
    } catch (e) { toast(e.message || 'Release search failed.', 'error', 4600); }
    finally { releasesLoading = false; }
  }
  async function grab(rel) {
    if (grabbing) return;
    grabbing = rel.guid;
    try {
      const payload = rel.source === 'prowlarr'
        ? { source: 'prowlarr', title: rel.title, downloadUrl: rel.downloadUrl, magnetUrl: rel.magnetUrl, protocol: rel.protocol, indexer: rel.indexer, publishDate: rel.publishDate }
        : { guid: rel.guid, indexerId: rel.indexerId };
      const r = await fetch(`/api/radarr/${film.id_tspdt}/releases`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.message || 'Grab failed.');
      toast(d?.via === 'qbittorrent' ? 'Radarr couldn’t match it — downloading via qBittorrent, will import automatically.' : 'Grabbing that release…', 'ok', d?.via === 'qbittorrent' ? 6500 : 3200);
      releases = null; downloadState = 'queued';
      loadRadarr(film.id_tspdt); loadWatch(film.id_tspdt);
    } catch (e) { toast(e.message || 'Could not grab that release.', 'error', 4600); }
    finally { grabbing = null; }
  }
  async function setKind(kind, on) {
    try {
      const r = await fetch('/api/status', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id_tspdt: film.id_tspdt, kind, on })
      });
      if (!r.ok) throw new Error();
      const d = await r.json();
      status = d.status; lbState = d.lb_state;
      if (d.counts) counts.set(d.counts);
    } catch { toast('Could not update your list.', 'error'); }
  }
  function toggleWatchlist() { setKind('watchlist', !watchlisted); }
  function toggleSeen() {
    if (!seen) { setKind('seen', true); return; }
    // Un-ticking a Letterboxd-imported watch warns first (kept as a record).
    if (lbWatched && !confirm(`“${displayTitle(film.title)}” is marked watched from your Letterboxd import.\n\nUn-tick it here? It stays recorded on the Letterboxd page.`)) return;
    setKind('seen', false);
  }
  function toggleRewatch() { setKind('rewatch', !rewatch); }
  function toggleUnfinished() { setKind('unfinished', !unfinished); }

  // Live Radarr status, polled while a download is in flight.
  async function loadRadarr(id) {
    try {
      const r = await fetch(`/api/radarr/${id}`);
      const s = await r.json();
      if (loadedId !== id) return;
      radarr = s;
      // Reflect Radarr's reality on the Download button: already in the library,
      // or a download already in flight.
      if (downloadState === 'idle') {
        if (s?.hasFile) downloadState = 'available';
        else if (s?.queue && !s.queue.error) downloadState = 'queued';
      }
      clearTimeout(radarrTimer);
      if (s?.present && !s.hasFile && (s.queue || s.monitored)) {
        radarrTimer = setTimeout(() => loadRadarr(id), 5000);
      }
    } catch { /* status is best-effort */ }
  }
  const gb = (n) => (n ? (n / 1e9).toFixed(n < 1e10 ? 2 : 1) + ' GB' : null);

  // Watch/encode capabilities + polling while an encode runs.
  async function loadWatch(id) {
    try {
      const w = await (await fetch(`/api/watch/${id}`)).json();
      if (loadedId !== id) return;
      watchInfo = w;
      clearTimeout(watchTimer);
      if (w?.encode?.state === 'running') watchTimer = setTimeout(() => loadWatch(id), 2500);
    } catch { /* best-effort */ }
  }
  async function startEncode() {
    try {
      const r = await fetch(`/api/encode/${film.id_tspdt}`, { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.message || 'Could not start encoding.');
      watchInfo = { ...(watchInfo || {}), encode: { state: d.state, percent: d.percent } };
      toast('Encoding on the iGPU…', 'ok');
      loadWatch(film.id_tspdt);
    } catch (e) { toast(e.message || 'Encode failed to start.', 'error', 4600); }
  }
  function openPlayer() {
    playing = true;
    setTimeout(() => {
      const pos = data.film.playback?.position;
      if (videoEl && pos > 5 && !pbCleared && (!runtimeSec || pos < runtimeSec)) videoEl.currentTime = pos;   // resume where you left off
      videoEl?.play?.().catch(() => {});
    }, 60);
  }
  function onTimeUpdate() {
    // Only persist progress for a SEEKABLE source (an encoded copy or a directly
    // playable file). A live iGPU transcode is a fragmented stream whose reported
    // duration is bogus/grows as it buffers, which produced nonsense like "91%".
    if (!videoEl || !watchInfo?.browser) return;
    const now = videoEl.currentTime;
    if (Math.abs(now - savedAt) < 5) return;               // throttle to ~5s
    savedAt = now;
    const dur = Number.isFinite(videoEl.duration) && videoEl.duration > 0 ? videoEl.duration : null;
    fetch(`/api/playback/${film.id_tspdt}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ position: now, duration: dur })
    }).catch(() => {});
  }
  async function resetProgress() {
    pbCleared = true;
    try { await fetch(`/api/playback/${film.id_tspdt}`, { method: 'DELETE' }); } catch { /* best-effort */ }
  }
  // Base the % on the film's real runtime (reliable) rather than the stream's
  // reported duration; hide implausible values outright.
  let runtimeSec = $derived((((ready && meta.runtime) || film.length_min || 0) * 60) || null);
  let pbPercent = $derived.by(() => {
    if (pbCleared) return null;
    const pos = data.film.playback?.position;
    if (!pos || pos < 30) return null;
    const dur = runtimeSec || data.film.playback?.duration;
    if (!dur || dur < 300 || pos > dur * 1.05) return null;
    return Math.min(100, Math.round((pos / dur) * 100));
  });

  const money = (n) => (n ? '$' + Number(n).toLocaleString() : null);
  let director = $derived((ready && meta.directors?.length ? meta.directors.join(', ') : film.director));
  let runtime = $derived((ready && meta.runtime) || film.length_min);
  let genres = $derived(ready && meta.genres?.length ? meta.genres
    : (film.genre && film.genre !== '---' ? film.genre.split('-') : []));
</script>

<svelte:head><title>{displayTitle(film.title)} ({film.year}) · Film Index</title></svelte:head>
<svelte:window onclick={(e) => {
  if (watchMenu && splitEl && !splitEl.contains(e.target)) watchMenu = false;
  if (dlMenu && dlSplitEl && !dlSplitEl.contains(e.target)) dlMenu = false;
}} />

<div class="backdrop" class:img={ready && meta.backdrop}
     style={ready && meta.backdrop ? `background-image:url("${meta.backdrop}")` : `background:${gradientFor(film.title)}`}></div>

<article class="detail">
  <a class="back" href="/">← Catalogue</a>

  <div class="top">
    <div class="poster-col"><Poster title={film.title} rank={film.latest_rank} src={ready ? meta.poster : null} big /></div>

    <div class="info">
      <h1>{displayTitle(film.title)}</h1>
      {#if ready && meta.tagline}<p class="tagline">“{meta.tagline}”</p>{/if}
      <div class="sub">{film.year ?? ''}{director ? ' · directed by ' + director : ''}</div>
      {#if pbPercent != null}
        <div class="pbwrap">
          <div class="pb"><span style="width:{pbPercent}%"></span></div>
          <span class="pblabel">Watched {pbPercent}%</span>
          <button class="pbreset" onclick={resetProgress} title="Reset watch progress"><Icon name="x" size={12} stroke={2.4} /></button>
        </div>
      {/if}

      <div class="ratings">
        {#if ready && meta.imdb_rating}
          <a class="rt-badge imdb" href={meta.imdb_url} target="_blank" rel="noopener" title="{meta.imdb_votes} votes on IMDb">
            <b>IMDb</b><span><Icon name="star" size={12} /> {meta.imdb_rating}</span>
          </a>
        {/if}
        {#if ready && meta.rotten}<span class="rt-badge"><b>Rotten Tomatoes</b><span>{meta.rotten}</span></span>{/if}
        {#if ready && (meta.metacritic || meta.metascore)}<span class="rt-badge"><b>Metacritic</b><span>{meta.metacritic || meta.metascore + '/100'}</span></span>{/if}
        {#if ready && meta.tmdb_rating}<span class="rt-badge"><b>TMDB</b><span>{meta.tmdb_rating.toFixed(1)}</span></span>{/if}
      </div>

      <div class="chips">
        <span class="chip rank">#{film.latest_rank} · TSPDT</span>
        {#each genres as g}<span class="chip">{g}</span>{/each}
        {#if runtime}<span class="chip">{runtime} min</span>{/if}
        {#if film.colour && film.colour !== '---'}<span class="chip">{colourLabel(film.colour)}</span>{/if}
      </div>

      {#if certs.length}
        <div class="certs">
          <span class="cert-badge" title="Age rating · {primaryCert.country}">{primaryCert.country} · {primaryCert.cert}</span>
          {#if certs.length > 1}
            <button class="cert-more" onclick={() => certsOpen = !certsOpen} aria-expanded={certsOpen}>{certsOpen ? 'Hide' : `+${certs.length - 1} more`}</button>
          {/if}
          {#if certsOpen}
            <div class="cert-grid">
              {#each certs as c}<span class="cert-item"><b>{c.country}</b> {c.cert}</span>{/each}
            </div>
          {/if}
        </div>
      {/if}

      <div class="cta">
        <div class="watch-split" class:has-caret={watchOptions.length > 1} bind:this={splitEl}>
          <button class="btn" class:primary={watchable} onclick={watchFilm}><Icon name="play" size={16} /> {isTauri ? 'Watch in mpv' : 'Watch'}</button>
          {#if watchOptions.length > 1}
            <button class="btn caret" class:primary={watchable} aria-label="Choose how to watch" aria-expanded={watchMenu} onclick={() => watchMenu = !watchMenu}><Icon name="chevron" size={15} /></button>
          {/if}
          {#if watchMenu}
            <div class="watch-menu" role="menu">
              {#each watchOptions as o}
                {#if o.href}
                  <a class="wm-item" role="menuitem" href={o.href} onclick={() => watchMenu = false}>{o.label}</a>
                {:else}
                  <button class="wm-item" role="menuitem" onclick={() => pickWatch(o)}>{o.label}</button>
                {/if}
              {/each}
            </div>
          {/if}
        </div>
        {#if radarr?.hasFile}
          <div class="watch-split has-caret" bind:this={dlSplitEl}>
            <a class="btn" href="/api/file/{film.id_tspdt}" download><Icon name="download" size={16} /> Download</a>
            <button class="btn caret" aria-label="Download options" aria-expanded={dlMenu} onclick={openDlMenu}><Icon name="chevron" size={15} /></button>
            {#if dlMenu}
              <div class="watch-menu" role="menu">
                <a class="wm-item" href="/api/file/{film.id_tspdt}" download onclick={() => dlMenu = false}><Icon name="download" size={14} /> Download file (best encode)</a>
                {#if grabLinks?.torrents?.length}
                  {@const many = grabLinks.torrents.length > 1}
                  {#each grabLinks.torrents as t}
                    <a class="wm-item" href="/api/file/{film.id_tspdt}/torrent?hash={t.hash}" download onclick={() => dlMenu = false} title={t.name}><Icon name="torrent" size={14} /> .torrent{many ? ' · ' + shortName(t.name) : ''}</a>
                    <a class="wm-item" href={t.magnet} onclick={() => dlMenu = false} title={t.name}><Icon name="magnet" size={14} /> Magnet{many ? ' · ' + shortName(t.name) : ''}</a>
                  {/each}
                {:else if grabLinks}
                  <div class="wm-empty">No torrent on the server for this film</div>
                {:else}
                  <div class="wm-empty">Looking up torrents…</div>
                {/if}
              </div>
            {/if}
          </div>
        {:else}
          <button class="btn" class:primary={!watchable} onclick={downloadFilm} disabled={dlBtn.disabled} aria-busy={dlBtn.spin}><Icon name={dlBtn.icon} size={16} spin={dlBtn.spin} /> {dlBtn.label}</button>
        {/if}
        <button class="btn" class:primary={!watchable} onclick={chooseRelease} disabled={releasesLoading} aria-busy={releasesLoading}><Icon name={releasesLoading ? 'sync' : 'search'} size={15} spin={releasesLoading} /> {releasesLoading ? 'Searching Radarr…' : 'Choose release'}</button>
        {#if ready && meta.trailer}<a class="btn" href={meta.trailer} target="_blank" rel="noopener"><Icon name="video" size={16} /> Trailer</a>{/if}
      </div>

      {#if !isTauri && !hideNudge}
        <div class="app-nudge">
          <div class="app-nudge-ic"><Icon name="monitor" size={17} /></div>
          <div class="app-nudge-txt">
            <b>Best picture quality is in the desktop app</b>
            <span>In-browser playback transcodes on the fly — lower quality and no seeking. The app plays the original file in mpv: full resolution, instant seeking, tuned for your display.</span>
          </div>
          <a class="app-nudge-cta" href="https://github.com/chrisJuresh/films/releases/latest" target="_blank" rel="noopener">Get the app</a>
          <button class="app-nudge-x" onclick={dismissNudge} aria-label="Dismiss"><Icon name="x" size={14} /></button>
        </div>
      {/if}

      <div class="actions">
        <button class="ghost" class:on={watchlisted} onclick={toggleWatchlist}><Icon name="heart" size={15} /> {watchlisted ? 'On watchlist' : 'Watchlist'}</button>
        <button class="ghost seen" class:on={seen} class:lb={lbWatched} onclick={toggleSeen}><Icon name="check" size={16} stroke={2.3} /> {seen ? (lbWatched ? 'Seen · Letterboxd' : 'Seen') : 'Mark seen'}</button>
      </div>
      <div class="actions minor">
        <button class="ghost sm rewatch" class:on={rewatch} onclick={toggleRewatch}><Icon name="rotate" size={14} /> {rewatch ? 'To rewatch' : 'Rewatch'}</button>
        <button class="ghost sm unfinished" class:on={unfinished} onclick={toggleUnfinished}><Icon name="hourglass" size={13} /> {unfinished ? 'Unfinished' : 'Didn’t finish'}</button>
      </div>

      {#if radarr?.present}
        <div class="radarr">
          {#if radarr.queue && radarr.queue.health === 'error'}
            <!-- Only a hard error (failed import/download) gets the red state. A
                 'warning' (e.g. stalled/no-connections) is transient — the torrent
                 is usually still progressing — so it shows as Downloading below. -->
            <div class="rr-row">
              <span class="rr-label err"><Icon name="alert" size={13} /> Download problem</span>
              <span class="rr-sub">{radarr.queue.quality && radarr.queue.quality !== 'Unknown' ? radarr.queue.quality : ''}</span>
            </div>
            {#if radarr.queue.error}<div class="rr-err">{radarr.queue.error}</div>{/if}
            {#if radarr.queue.client || radarr.queue.indexer}<div class="rr-meta">{[radarr.queue.client, radarr.queue.indexer, radarr.queue.protocol].filter(Boolean).join(' · ')}</div>{/if}
            <button class="rr-cancel" onclick={cancelDownload} disabled={cancelling} aria-busy={cancelling}>{cancelling ? 'Cancelling…' : 'Cancel download'}</button>
          {:else if radarr.queue}
            <div class="rr-row">
              <span class="rr-label">{radarr.queue.state === 'importPending' || radarr.queue.state === 'importing' ? 'Importing' : 'Downloading'}{radarr.queue.quality && radarr.queue.quality !== 'Unknown' ? ' · ' + radarr.queue.quality : ''}</span>
              <span class="rr-sub">{radarr.queue.progress != null ? radarr.queue.progress + '%' : ''}{radarr.queue.timeleft ? ' · ' + radarr.queue.timeleft + ' left' : ''}</span>
            </div>
            <div class="rr-bar" class:indef={radarr.queue.progress == null}><span style="width:{radarr.queue.progress ?? 100}%"></span></div>
            {#if radarr.queue.health === 'warning' && radarr.queue.error}<div class="rr-warn"><Icon name="alert" size={12} /> {radarr.queue.error}</div>{/if}
            {#if radarr.queue.client || radarr.queue.indexer}<div class="rr-meta">via {[radarr.queue.client, radarr.queue.indexer, radarr.queue.protocol].filter(Boolean).join(' · ')}</div>{/if}
            <button class="rr-cancel" onclick={cancelDownload} disabled={cancelling} aria-busy={cancelling}>{cancelling ? 'Cancelling…' : 'Cancel download'}</button>
          {:else if radarr.hasFile}
            <div class="rr-row">
              <span class="rr-label ok"><Icon name="check" size={14} stroke={2.3} /> In your library</span>
              <span class="rr-sub">{[radarr.quality, radarr.resolution, radarr.videoCodec, gb(radarr.sizeOnDisk)].filter(Boolean).join(' · ')}</span>
            </div>
            {#if radarr.releaseGroup}<div class="rr-meta">Release group · {radarr.releaseGroup}</div>{/if}
          {:else if radarr.qb}
            <div class="rr-row">
              <span class="rr-label">{radarr.qb.done ? 'Importing' : 'Downloading'} · qBittorrent</span>
              <span class="rr-sub">{radarr.qb.progress}%{radarr.qb.eta ? ' · ~' + Math.round(radarr.qb.eta / 60) + 'm left' : ''}</span>
            </div>
            <div class="rr-bar"><span style="width:{radarr.qb.progress}%"></span></div>
            <div class="rr-meta">{radarr.qb.done ? 'Downloaded — importing into Radarr…' : 'Direct download (Radarr couldn’t match the title); imports automatically when done.'}</div>
          {:else}
            <div class="rr-row">
              <span class="rr-label">In Radarr</span>
              <span class="rr-sub">{radarr.monitored ? 'monitored · searching…' : 'not monitored'}{radarr.movieStatus && radarr.movieStatus !== 'released' ? ' · ' + radarr.movieStatus : ''}</span>
            </div>
          {/if}
        </div>
      {/if}

      {#if watchInfo && (watchInfo.hasFile || watchInfo.encoded)}
        <div class="play">
          {#if !watchInfo.browser && !isTauri}
            <button class="btn" onclick={openPlayer} disabled={playing}><Icon name="play" size={16} /> Stream (iGPU transcode)</button>
          {/if}
          {#if watchInfo.encode?.state === 'running'}
            <div class="enc"><span>Encoding · {watchInfo.encode.percent}%</span><div class="rr-bar"><span style="width:{watchInfo.encode.percent}%"></span></div></div>
          {:else if watchInfo.encoded}
            <a class="btn" href="/api/encode/{film.id_tspdt}/download"><Icon name="download" size={16} /> Download encoded</a>
          {:else if watchInfo.hasFile}
            <button class="btn" onclick={startEncode}><Icon name="download" size={16} /> Encode &amp; download (iGPU)</button>
          {/if}
        </div>
        {#if isTauri && playerInfo}<div class="rr-meta">Desktop · {playerInfo.os}{playerInfo.mpv ? ' · mpv ready' : ' · using system default player'}</div>{/if}
        {#if watchInfo.encode?.state === 'error'}<div class="rr-err">Encode failed — {watchInfo.encode.error}</div>{/if}
      {/if}
    </div>
  </div>

  {#if playing}
    <section class="player">
      <video bind:this={videoEl} src="/api/stream/{film.id_tspdt}" controls autoplay playsinline ontimeupdate={onTimeUpdate}></video>
      {#if !watchInfo?.browser}<div class="rr-meta">Live iGPU transcode · seeking is limited until an encoded copy exists.</div>{/if}
    </section>
  {/if}

  {#if releases}
    <section class="block releases">
      <div class="rel-head">
        <div class="section-h">Releases · {sortedReleases.length} found</div>
        {#if sortedReleases.length > 1}
          <div class="rel-sort" role="group" aria-label="Sort releases">
            <span>Sort</span>
            <button class:on={sortBy === 'quality'} onclick={() => sortBy = 'quality'}>Quality</button>
            <button class:on={sortBy === 'seeders'} onclick={() => sortBy = 'seeders'}>Seeders</button>
            <button class:on={sortBy === 'size'} onclick={() => sortBy = 'size'}>Size</button>
          </div>
        {/if}
      </div>
      {#if releasesFallback}<p class="rr-meta">Radarr found nothing on its year, so these are from a Prowlarr search on {film.year} — grabbing pushes the release back through Radarr so it still imports.</p>{/if}
      {#if radarr?.hasFile}<p class="rr-meta">Already in your library — grabbing fetches another release (Radarr treats it as an upgrade/replace).</p>{/if}
      {#if sortedReleases.length === 0}
        <p class="rr-meta">No releases found{releasesFallback ? '' : ' — Radarr searches on TMDB’s year for this film'}.</p>
      {:else}
        {#each sortedReleases as r (r.guid)}
          <div class="rel" class:rej={r.rejected} class:pick={r.guid === autoPickGuid}>
            <div class="seeders" class:hot={(r.seeders || 0) >= 10} class:cold={(r.seeders || 0) === 0} title="{r.seeders ?? '?'} seeders">
              <Icon name="up" size={12} stroke={2.6} />
              <b>{r.seeders ?? '–'}</b>
              <span>seed</span>
            </div>
            <div class="rel-info">
              <div class="rel-title">
                {#if r.quality}<span class="qbadge">{r.quality}</span>{/if}
                <span class="rel-name">{r.title}</span>
                {#if r.guid === autoPickGuid}<span class="rel-tag pick" title="What the Download button would grab">Radarr’s pick</span>{/if}
                {#if r.source === 'prowlarr'}<span class="rel-tag">Prowlarr</span>{/if}
              </div>
              <div class="rel-sub">{[r.size ? gb(r.size) : null, r.languages.join('/'), r.indexer, r.protocol].filter(Boolean).join(' · ')}{r.score ? ' · CF ' + r.score : ''}</div>
              {#if r.rejected && r.rejections.length}<div class="rel-rej">{r.rejections.slice(0, 2).join('; ')}</div>{/if}
            </div>
            <button class="btn sm" class:warn={r.rejected} disabled={!!grabbing} aria-busy={grabbing === r.guid} onclick={() => grab(r)}>
              {#if grabbing === r.guid}<Icon name="sync" size={13} spin /> Grabbing…{:else}{r.rejected ? 'Grab anyway' : 'Grab'}{/if}
            </button>
          </div>
        {/each}
      {/if}
    </section>
  {/if}

  {#if ready && (meta.overview || meta.plot)}
    <section class="block"><div class="section-h">Synopsis</div><p class="overview">{meta.plot || meta.overview}</p></section>
  {/if}

  {#if ready && meta.cast?.length}
    <section class="block">
      <div class="section-h">Cast</div>
      <div class="cast">
        {#each meta.cast as c}
          <div class="cast-card">
            <div class="avatar" style={c.photo ? `background-image:url("${c.photo}")` : ''}>
              {#if !c.photo}<span>{c.name.split(' ').map((w) => w[0]).slice(0, 2).join('')}</span>{/if}
            </div>
            <div class="cn">{c.name}</div>
            {#if c.character}<div class="cc">{c.character}</div>{/if}
          </div>
        {/each}
      </div>
    </section>
  {/if}

  {#if ready}
    <section class="block">
      <div class="section-h">Details</div>
      <dl class="facts">
        {#if meta.directors?.length}<dt>Director</dt><dd>{meta.directors.join(', ')}</dd>{/if}
        {#if meta.writers?.length}<dt>Writers</dt><dd>{meta.writers.join(', ')}</dd>{/if}
        {#if meta.released}<dt>Released</dt><dd>{meta.released}</dd>{/if}
        {#if meta.country}<dt>Country</dt><dd>{meta.country}</dd>{:else if film.country}<dt>Country</dt><dd>{film.country}</dd>{/if}
        {#if meta.language}<dt>Language</dt><dd>{meta.language}</dd>{/if}
        {#if meta.awards}<dt>Awards</dt><dd>{meta.awards}</dd>{/if}
        {#if meta.box_office}<dt>Box office</dt><dd>{meta.box_office}</dd>{/if}
        {#if meta.budget}<dt>Budget</dt><dd>{money(meta.budget)}</dd>{/if}
        {#if meta.revenue}<dt>Revenue</dt><dd>{money(meta.revenue)}</dd>{/if}
        {#if meta.companies?.length}<dt>Production</dt><dd>{meta.companies.join(', ')}</dd>{/if}
      </dl>
    </section>
  {/if}

  <section class="block">
    <div class="section-h">Ranking history · {film.history.length} editions</div>
    <Sparkline history={film.history} />
  </section>
</article>

<style>
  .backdrop { position: fixed; inset: 0 0 auto 0; height: 520px; z-index: -1; opacity: .38;
    background-size: cover; background-position: center top; mask-image: linear-gradient(#000 8%, transparent); }
  .backdrop:not(.img) { filter: blur(60px) saturate(1.2); opacity: .5; }
  .detail { max-width: 1060px; margin: 0 auto; padding: 26px 30px 70px; }
  .back { display: inline-block; color: var(--muted); text-decoration: none; font-size: 13.5px; margin-bottom: 20px; }
  .back:hover { color: var(--text); }

  .top { display: grid; grid-template-columns: 288px 1fr; gap: 36px; }
  .poster-col { position: sticky; top: 26px; align-self: start; }

  h1 { font-family: var(--font-display); font-weight: 700; font-size: clamp(28px, 4vw, 46px);
    line-height: 1.05; letter-spacing: -.02em; margin: 4px 0 4px; }
  .tagline { color: var(--muted); font-style: italic; font-family: var(--font-display); font-size: 16px; margin: 0 0 6px; }
  .sub { color: var(--muted); font-size: 15px; margin-bottom: 18px; }

  .ratings { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 16px; }
  .rt-badge { display: inline-flex; align-items: center; gap: 7px; padding: 6px 11px; border-radius: 10px;
    border: 1px solid var(--border); background: var(--surface-2); font-size: 13px; text-decoration: none; color: var(--text); }
  .rt-badge b { font-size: 11px; letter-spacing: .03em; color: var(--muted); font-weight: 600; }
  .rt-badge.imdb b { color: #f5c518; } .rt-badge.imdb { border-color: color-mix(in srgb, #f5c518 40%, var(--border)); }
  .rt-badge span { font-weight: 700; font-variant-numeric: tabular-nums; }

  .chips { display: flex; flex-wrap: wrap; gap: 7px; margin-bottom: 22px; }
  .chip { font-size: 12px; padding: 5px 11px; border-radius: 999px; border: 1px solid var(--border);
    background: var(--surface-2); color: var(--muted); }
  .chip.rank { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); font-weight: 700; }

  /* Age ratings: one representative badge + an expandable breakdown, instead of
     a wall of per-country pills. */
  .certs { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: -12px 0 22px; }
  .cert-badge { font-size: 12px; font-weight: 600; padding: 4px 10px; border-radius: 7px; letter-spacing: .02em;
    border: 1px solid var(--border-strong); color: var(--text); font-variant-numeric: tabular-nums; }
  .cert-more { font-size: 12px; color: var(--muted); background: none; border: 0; cursor: pointer; padding: 2px 4px;
    text-decoration: underline; text-underline-offset: 2px; }
  .cert-more:hover { color: var(--text); }
  .cert-grid { flex-basis: 100%; display: flex; flex-wrap: wrap; gap: 6px 14px; margin-top: 4px; }
  .cert-item { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .cert-item b { color: var(--faint); font-weight: 600; margin-right: 4px; }

  .cta { display: flex; gap: 12px; flex-wrap: wrap; }

  /* "Get the app" nudge — the browser player is a fallback; the app is best. */
  .app-nudge { display: flex; align-items: center; gap: 13px; flex-wrap: wrap; margin: 16px 0 2px; padding: 12px 14px;
    border-radius: 13px; border: 1px solid color-mix(in srgb, var(--accent) 26%, var(--border));
    background: linear-gradient(180deg, color-mix(in srgb, var(--accent) 9%, transparent), transparent); }
  .app-nudge-ic { flex: none; width: 34px; height: 34px; border-radius: 9px; display: grid; place-items: center;
    color: var(--accent-ink); background: var(--accent); }
  .app-nudge-txt { flex: 1 1 220px; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .app-nudge-txt b { font-size: 13.5px; }
  .app-nudge-txt span { font-size: 12px; color: var(--muted); line-height: 1.4; }
  .app-nudge-cta { flex: none; padding: 8px 15px; border-radius: 9px; background: var(--accent); color: var(--accent-ink);
    font-size: 13px; font-weight: 600; text-decoration: none; white-space: nowrap; }
  .app-nudge-cta:hover { filter: brightness(1.06); }
  .app-nudge-x { flex: none; width: 26px; height: 26px; border-radius: 999px; border: 0; background: transparent;
    color: var(--faint); cursor: pointer; display: grid; place-items: center; }
  .app-nudge-x:hover { color: var(--text); }
  .btn { padding: 13px 22px; border-radius: 12px; border: 1px solid var(--border-strong); background: var(--surface-2);
    color: var(--text); font-size: 15px; font-weight: 600; cursor: pointer; font-family: inherit; text-decoration: none;
    display: inline-flex; align-items: center; gap: 8px; transition: transform .12s, border-color .12s; }
  .btn:hover:not(:disabled) { border-color: var(--accent); transform: translateY(-1px); }
  .btn:disabled { opacity: .55; cursor: progress; }
  .btn.primary { background: linear-gradient(120deg, var(--accent), color-mix(in srgb, var(--accent) 70%, #d98324));
    color: var(--accent-ink); border: none; box-shadow: 0 8px 24px color-mix(in srgb, var(--accent) 30%, transparent); }

  .actions { display: flex; gap: 10px; margin-top: 18px; }
  .ghost { padding: 9px 15px; border-radius: 10px; border: 1px solid var(--border); background: transparent;
    color: var(--text); font-size: 13.5px; cursor: pointer; font-family: inherit; transition: all .12s;
    display: inline-flex; align-items: center; gap: 7px; }
  .ghost:hover { border-color: var(--border-strong); }
  .ghost.on { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
  .ghost.seen.on { background: var(--free); color: #06210b; border-color: var(--free); }
  .ghost.seen.on.lb { background: var(--lb); color: var(--lb-ink); border-color: var(--lb); }
  .actions.minor { margin-top: 10px; }
  .ghost.sm { padding: 7px 13px; font-size: 12.5px; color: var(--muted); }
  .ghost.sm:hover { color: var(--text); }
  .ghost.rewatch.on { background: var(--rewatch); color: var(--rewatch-ink); border-color: var(--rewatch); }
  .ghost.unfinished.on { background: var(--unfinished); color: var(--unfinished-ink); border-color: var(--unfinished); }

  .radarr { margin-top: 16px; padding: 11px 14px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface-2); }
  .rr-row { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
  .rr-label { font-size: 13.5px; font-weight: 600; display: inline-flex; align-items: center; gap: 6px; }
  .rr-label.ok { color: var(--free); }
  .rr-sub { color: var(--muted); font-size: 12.5px; font-variant-numeric: tabular-nums; text-align: right; }
  .rr-bar { margin-top: 9px; height: 6px; border-radius: 999px; background: var(--surface); overflow: hidden; }
  .rr-bar span { display: block; height: 100%; background: var(--accent); border-radius: 999px; transition: width .6s ease; }
  .rr-bar.indef span { width: 35% !important; animation: rr-indef 1.3s ease-in-out infinite; }
  @keyframes rr-indef { 0% { margin-left: -35%; } 100% { margin-left: 100%; } }
  .rr-err { margin-top: 8px; font-size: 12px; color: #e5675c; }
  .rr-label.err { color: #e5675c; }
  .rr-warn { margin-top: 8px; font-size: 11.5px; color: #d9a441; display: inline-flex; align-items: center; gap: 5px; }
  .rr-meta { margin-top: 7px; font-size: 11.5px; color: var(--faint); }
  .rr-cancel { margin-top: 9px; padding: 5px 11px; border-radius: 8px; border: 1px solid var(--border);
    background: transparent; color: var(--muted); font-size: 12px; cursor: pointer; font-family: inherit; }
  .rr-cancel:hover { color: #e5675c; border-color: color-mix(in srgb, #e5675c 45%, var(--border)); }

  .pbwrap { display: flex; align-items: center; gap: 10px; margin: 6px 0 12px; }
  .pb { flex: 1; height: 5px; border-radius: 999px; background: var(--surface-2); overflow: hidden; max-width: 320px; }
  .pb span { display: block; height: 100%; background: var(--free); border-radius: 999px; }
  .pblabel { font-size: 11.5px; color: var(--faint); font-variant-numeric: tabular-nums; }
  .pbreset { display: inline-grid; place-items: center; width: 20px; height: 20px; padding: 0; border-radius: 999px;
    border: 1px solid var(--border); background: transparent; color: var(--faint); cursor: pointer; transition: all .12s; }
  .pbreset:hover { color: var(--text); border-color: var(--border-strong); }

  .play { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin-top: 14px; }
  .enc { display: flex; flex-direction: column; gap: 5px; min-width: 200px; font-size: 12.5px; color: var(--muted); }

  .player { margin-top: 30px; }
  .player video { width: 100%; max-height: 78vh; border-radius: 16px; background: #000;
    border: 1px solid var(--border-strong); box-shadow: var(--shadow); display: block; }

  .rel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 6px; }
  .rel-sort { display: flex; align-items: center; gap: 5px; font-size: 12px; color: var(--muted); }
  .rel-sort button { padding: 4px 11px; border-radius: 999px; border: 1px solid var(--border); background: transparent;
    color: var(--muted); font-size: 12px; cursor: pointer; transition: all .12s ease; }
  .rel-sort button:hover { color: var(--text); }
  .rel-sort button.on { color: var(--accent-ink); background: var(--accent); border-color: var(--accent); }

  .releases .rel { display: flex; align-items: center; gap: 13px; padding: 11px 12px; border-radius: 12px;
    border: 1px solid transparent; border-bottom: 1px solid var(--border); }
  .releases .rel:last-child { border-bottom: 1px solid transparent; }
  .rel.pick { background: color-mix(in srgb, var(--accent) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border)); }
  .rel.rej { opacity: .72; }

  .seeders { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0;
    min-width: 52px; padding: 5px 6px; border-radius: 9px; background: var(--surface); border: 1px solid var(--border);
    color: var(--muted); line-height: 1; }
  .seeders b { font-size: 15px; color: var(--text); font-variant-numeric: tabular-nums; margin-top: 1px; }
  .seeders span { font-size: 8.5px; text-transform: uppercase; letter-spacing: .06em; margin-top: 2px; }
  .seeders.hot { color: var(--free); border-color: color-mix(in srgb, var(--free) 45%, var(--border));
    background: color-mix(in srgb, var(--free) 10%, transparent); }
  .seeders.hot b { color: var(--free); }
  .seeders.cold { opacity: .55; }

  .rel-info { flex: 1; min-width: 0; }
  .rel-title { font-size: 13px; line-height: 1.35; display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
  .rel-name { word-break: break-word; }
  .qbadge { font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 6px; letter-spacing: .01em;
    background: var(--surface-2); border: 1px solid var(--border); color: var(--text); white-space: nowrap; }
  .rel-tag { font-size: 10px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase;
    color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--border)); border-radius: 5px; padding: 1px 6px; }
  .rel-tag.pick { color: var(--free); border-color: color-mix(in srgb, var(--free) 45%, var(--border));
    background: color-mix(in srgb, var(--free) 12%, transparent); }
  .rel-sub { font-size: 12px; color: var(--muted); margin-top: 3px; font-variant-numeric: tabular-nums; }
  .rel-rej { font-size: 11.5px; color: #e5675c; margin-top: 3px; }
  .btn.sm { padding: 7px 14px; font-size: 13px; flex: none; align-self: center; }
  .btn.sm.warn { color: #d9a441; border-color: color-mix(in srgb, #d9a441 45%, var(--border)); }

  /* Watch split button + its "how to watch" dropdown */
  .watch-split { position: relative; display: inline-flex; }
  .watch-split.has-caret .btn:first-child { border-top-right-radius: 3px; border-bottom-right-radius: 3px; }
  .watch-split .btn.caret { border-top-left-radius: 3px; border-bottom-left-radius: 3px;
    padding-left: 9px; padding-right: 9px; margin-left: 2px; }
  .watch-menu { position: absolute; top: calc(100% + 7px); left: 0; z-index: 40; min-width: 234px; padding: 6px;
    background: var(--surface-2); border: 1px solid var(--border-strong); border-radius: 13px; box-shadow: var(--shadow); }
  .wm-item { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; padding: 9px 11px;
    border-radius: 8px; border: 0; background: transparent; color: var(--text); font-size: 13px; cursor: pointer;
    text-decoration: none; white-space: nowrap; }
  .wm-item:hover { background: var(--surface); }
  .wm-empty { padding: 9px 11px; font-size: 12.5px; color: var(--muted); }

  .block { margin-top: 36px; border-top: 1px solid var(--border); padding-top: 26px; }
  .section-h { font-size: 11px; text-transform: uppercase; letter-spacing: .13em; color: var(--faint); margin: 0 0 14px; }
  .overview { font-size: 15.5px; line-height: 1.62; color: var(--text); max-width: 74ch; margin: 0; }

  .cast { display: flex; gap: 14px; overflow-x: auto; padding-bottom: 8px; }
  .cast-card { flex: 0 0 104px; text-align: center; }
  .avatar { width: 104px; height: 104px; border-radius: 12px; background: var(--surface-2); background-size: cover;
    background-position: center; display: grid; place-items: center; border: 1px solid var(--border); margin-bottom: 8px; }
  .avatar span { font-family: var(--font-display); font-weight: 700; font-size: 26px; color: var(--faint); }
  .cn { font-size: 13px; font-weight: 600; line-height: 1.2; }
  .cc { font-size: 12px; color: var(--muted); line-height: 1.2; margin-top: 2px; }

  .facts { display: grid; grid-template-columns: 130px 1fr; gap: 10px 18px; margin: 0; font-size: 14px; }
  .facts dt { color: var(--faint); }
  .facts dd { margin: 0; }

  @media (max-width: 720px) {
    .detail { padding: 18px 16px 60px; }
    .backdrop { height: 340px; }
    .top { grid-template-columns: 1fr; gap: 22px; }
    .poster-col { position: static; max-width: 190px; }
    .facts { grid-template-columns: 104px 1fr; }
    /* CTAs fill the row instead of leaving ragged gaps when they wrap. */
    .cta { gap: 10px; }
    .cta .btn { flex: 1 1 42%; justify-content: center; padding: 13px 14px; }
    .block { margin-top: 28px; padding-top: 22px; }
  }
</style>
