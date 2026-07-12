<script>
  import { onMount } from 'svelte';
  import { browser } from '$app/environment';
  import { invalidateAll } from '$app/navigation';
  import FilmCard from '$lib/components/FilmCard.svelte';
  import DownloadRow from '$lib/components/DownloadRow.svelte';
  import LocalRow from '$lib/components/LocalRow.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import { downloads, toast } from '$lib/stores.js';

  let { data } = $props();
  const isTauri = browser && !!window.__TAURI__?.core?.invoke;

  async function openDownloadsFolder() {
    try { await window.__TAURI__.core.invoke('open_downloads_dir'); }
    // Tauri rejects with the Err STRING (not an Error), so surface it directly.
    catch (e) { toast('Could not open the folder: ' + (typeof e === 'string' ? e : e?.message || 'unknown error'), 'error', 6000); }
  }

  /* ---- Radarr (server-side) downloads ----
     Counts come from the layout load (data.downloads); the four lists from this
     page's load. Locally-cancelled ids are filtered until Radarr's snapshot
     catches up (its 45s TTL can otherwise briefly resurrect a cancelled row). */
  let cancelled = $state(new Set());
  let downloading = $derived(data.downloading.filter((f) => !cancelled.has(f.id_tspdt)));
  let wanted = $derived(data.wanted);
  let errored = $derived(data.errored);
  let downloaded = $derived(data.downloaded);
  let counts = $derived(data.downloads || { downloaded: 0, downloading: 0, wanted: 0, error: 0 });
  let postersEnabled = $derived(!!data.meta?.tmdb);
  function onCancel(id) { cancelled = new Set([...cancelled, id]); invalidateAll(); }

  /* ---- "Save to PC" downloads (desktop app only) ----
     $downloads is this session's live progress (keyed by film id); local_downloads
     lists what's actually on disk (survives restarts). Titles/posters come from
     /api/films/by-id — these films needn't be in any Radarr state. */
  let localList = $state([]);        // [{ id, path, size }] on disk
  let metaMap = $state({});          // id -> { title, rank, year, director, imdb_id } | null

  async function refreshLocal() {
    if (!isTauri) return;
    try { localList = (await window.__TAURI__.core.invoke('local_downloads')) || []; }
    catch { localList = []; }        // older app that lacks the command
  }

  let localSaving = $derived(Object.entries($downloads)
    .filter(([, d]) => !d.done)
    .map(([id, d]) => ({ id: +id, pct: d.pct, film: metaMap[id] || null })));
  let localFailed = $derived(Object.entries($downloads)
    .filter(([, d]) => d.done && d.error)
    .map(([id, d]) => ({ id: +id, error: d.error, film: metaMap[id] || null })));
  // A file is complete unless local_downloads flags it complete:false (an older
  // app without the flag omitted incomplete files, so undefined ⇒ complete).
  let localSaved = $derived.by(() => {
    const m = new Map();
    for (const x of localList) if (x.complete !== false) m.set(x.id, { id: x.id, path: x.path, size: x.size, film: metaMap[x.id] || null });
    for (const [id, d] of Object.entries($downloads)) {            // just-finished, before the disk re-list lands
      const n = +id;
      if (d.done && !d.error && !m.has(n)) m.set(n, { id: n, path: null, size: null, film: metaMap[id] || null });
    }
    return [...m.values()];
  });
  // Leftover .part files (interrupted saves) — but not ones actively saving now.
  let localIncomplete = $derived(localList
    .filter((x) => x.complete === false && !(String(x.id) in $downloads))
    .map((x) => ({ id: x.id, path: x.path, size: x.size, film: metaMap[x.id] || null })));
  let localTotal = $derived(localSaving.length + localFailed.length + localIncomplete.length + localSaved.length);

  let total = $derived(downloading.length + wanted.length + errored.length + downloaded.length);
  // In the app the "On this PC" section always shows (so the folder button is
  // always reachable), so the big empty state is only for the web with nothing.
  let nothing = $derived(total === 0 && !isTauri);

  // Re-list the disk whenever a save completes (done count rises), and on mount.
  let doneCount = $derived(Object.values($downloads).filter((d) => d.done && !d.error).length);
  $effect(() => { void doneCount; refreshLocal(); });

  // Resolve titles for any ids we don't have yet; mark attempted ids (even
  // unresolvable ones) so the effect settles instead of refetching forever.
  $effect(() => {
    if (!isTauri) return;
    const ids = new Set([...Object.keys($downloads).map(Number), ...localList.map((x) => x.id)]);
    const missing = [...ids].filter((id) => !(id in metaMap));
    if (!missing.length) return;
    fetch('/api/films/by-id?ids=' + missing.join(','))
      .then((r) => r.json())
      .then((rows) => {
        const add = {};
        for (const f of rows) add[f.id_tspdt] = f;
        for (const id of missing) if (!(id in add)) add[id] = null;
        metaMap = { ...metaMap, ...add };
      })
      .catch(() => {});
  });

  // Live-ish: re-run the loads every 15s while the tab is visible. The Radarr
  // pull behind it is TTL-guarded, so this is cheap and self-throttling.
  onMount(() => {
    const tick = () => { if (document.visibilityState === 'visible') invalidateAll(); };
    const timer = setInterval(tick, 15000);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  });
</script>

<svelte:head><title>Downloads · Film Index</title></svelte:head>

<div class="wrap">
  <header class="head">
    <a class="back" href="/">← Catalogue</a>
    <h1>Downloads</h1>
    <p class="sub">Films moving through Radarr — searching, downloading, and landed in your library. Updates automatically.</p>
    <div class="pills">
      <span class="pill" class:live={counts.downloading}><b>{counts.downloading}</b> downloading</span>
      <span class="pill"><b>{counts.wanted}</b> wanted</span>
      {#if counts.error}<span class="pill err"><b>{counts.error}</b> to sort out</span>{/if}
      <span class="pill done"><b>{counts.downloaded}</b> in library</span>
    </div>
  </header>

  {#if nothing}
    <div class="empty">
      <Icon name="download" size={30} />
      <p>Nothing downloading yet.</p>
      <span>Open a film and hit <em>Download</em>{#if isTauri} or <em>Save to PC</em>{/if} — it'll show up here.</span>
      <a class="cta" href="/">Browse the catalogue</a>
    </div>
  {:else}
    {#if isTauri}
      <section>
        <h2><Icon name="monitor" size={15} stroke={2} /> On this PC {#if localTotal}<span class="n">{localTotal}</span>{/if}
          <button class="folder-btn" onclick={openDownloadsFolder} title="Open the “Save to PC” folder"><Icon name="folder" size={14} /> Folder</button>
        </h2>
        <p class="hint">Your “Save to PC” copies — kept locally for offline mpv playback. (Separate from the catalogue's “In library”, which lives on the server.)</p>
        {#if localTotal}
          <div class="rows">
            {#each localSaving as x (x.id)}
              <LocalRow id={x.id} film={x.film} kind="saving" pct={x.pct} />
            {/each}
            {#each localFailed as x (x.id)}
              <LocalRow id={x.id} film={x.film} kind="error" error={x.error} />
            {/each}
            {#each localIncomplete as x (x.id)}
              <LocalRow id={x.id} film={x.film} kind="incomplete" path={x.path} size={x.size} />
            {/each}
            {#each localSaved as x (x.id)}
              <LocalRow id={x.id} film={x.film} kind="saved" path={x.path} size={x.size} />
            {/each}
          </div>
        {:else}
          <p class="empty-sm">No “Save to PC” copies found in the app's folder. Start one from a film page, or click <em>Folder</em> to see what's there. (A film that's only <em>downloaded</em> to the library isn't saved to this PC.)</p>
        {/if}
      </section>
    {/if}

    {#if downloading.length}
      <section>
        <h2><Icon name="download" size={16} stroke={2.2} /> Downloading <span class="n">{downloading.length}</span></h2>
        <div class="rows">
          {#each downloading as f (f.id_tspdt)}
            <DownloadRow film={f} kind="downloading" {postersEnabled} oncancel={onCancel} />
          {/each}
        </div>
      </section>
    {/if}

    {#if wanted.length}
      <section>
        <h2><Icon name="search" size={15} stroke={2.2} /> Wanted <span class="n">{wanted.length}</span></h2>
        <p class="hint">Monitored — Radarr is searching indexers. Open one to pick a release by hand.</p>
        <div class="rows">
          {#each wanted as f (f.id_tspdt)}
            <DownloadRow film={f} kind="wanted" {postersEnabled} />
          {/each}
        </div>
      </section>
    {/if}

    {#if errored.length}
      <section>
        <h2 class="e"><Icon name="alert" size={15} stroke={2.2} /> To sort out <span class="n">{errored.length}</span></h2>
        <p class="hint">Radarr couldn't complete these — open a film to choose a release or retry.</p>
        <div class="rows">
          {#each errored as f (f.id_tspdt)}
            <DownloadRow film={f} kind="error" {postersEnabled} />
          {/each}
        </div>
      </section>
    {/if}

    {#if downloaded.length}
      <section>
        <h2><Icon name="hdd" size={15} stroke={2} /> In library <span class="n">{counts.downloaded}</span></h2>
        <div class="grid">
          {#each downloaded as f (f.id_tspdt)}
            <FilmCard film={f} {postersEnabled} />
          {/each}
        </div>
        {#if counts.downloaded > downloaded.length}
          <p class="hint">Showing the top {downloaded.length} by ranking. <a href="/?radarr=downloaded">See all in the catalogue →</a></p>
        {/if}
      </section>
    {/if}
  {/if}
</div>

<style>
  .wrap { padding: 26px 30px 70px; max-width: 1100px; }
  .head { margin-bottom: 26px; }
  .back { color: var(--muted); font-size: 13px; text-decoration: none; }
  .back:hover { color: var(--text); }
  h1 { font-family: var(--font-display); font-size: 30px; font-weight: 700; margin: 10px 0 4px; }
  .sub { color: var(--muted); font-size: 14px; max-width: 60ch; }
  .pills { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
  .pill { font-size: 13px; color: var(--muted); padding: 5px 11px; border-radius: 999px;
    border: 1px solid var(--border); background: var(--surface); font-variant-numeric: tabular-nums; }
  .pill b { color: var(--text); font-weight: 700; }
  .pill.live { border-color: color-mix(in srgb, #2f7de1 55%, var(--border)); }
  .pill.live b { color: #4a90e2; }
  .pill.done b { color: #4a90e2; }
  .pill.err { border-color: color-mix(in srgb, #e5675c 45%, var(--border)); }
  .pill.err b { color: #e5675c; }

  section { margin-top: 30px; }
  h2 { display: flex; align-items: center; gap: 9px; font-family: var(--font-display); font-size: 18px;
    font-weight: 600; margin-bottom: 12px; }
  h2 :global(.icon) { color: var(--muted); }
  h2.e, h2.e :global(.icon) { color: #e5675c; }
  h2 .n { font-size: 13px; color: var(--faint); font-weight: 500; font-variant-numeric: tabular-nums; }
  .folder-btn { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px;
    font-weight: 600; padding: 6px 12px; border-radius: 999px; border: 1px solid var(--border);
    background: var(--surface); color: var(--muted); cursor: pointer; transition: all .14s; }
  .folder-btn:hover { color: var(--text); border-color: var(--border-strong); }
  .folder-btn :global(.icon) { color: var(--accent); }
  .hint { color: var(--muted); font-size: 13px; margin: -4px 0 12px; }
  .empty-sm { color: var(--muted); font-size: 13px; padding: 14px 16px; border: 1px dashed var(--border);
    border-radius: 12px; max-width: 70ch; }
  .empty-sm em { font-style: normal; color: var(--text); font-weight: 600; }
  .hint a { color: var(--accent); text-decoration: none; }
  .hint a:hover { text-decoration: underline; }
  .rows { display: flex; flex-direction: column; gap: 8px; }
  .grid { display: grid; gap: 24px 18px; grid-template-columns: repeat(auto-fill, minmax(158px, 1fr)); }

  .empty { text-align: center; color: var(--muted); padding: 70px 20px; display: flex; flex-direction: column;
    align-items: center; gap: 10px; border: 1px dashed var(--border); border-radius: 16px; }
  .empty :global(.icon) { color: var(--faint); }
  .empty p { font-family: var(--font-display); font-size: 18px; color: var(--text); font-weight: 600; margin: 0; }
  .empty span { font-size: 13.5px; max-width: 44ch; }
  .empty em { font-style: normal; color: var(--text); font-weight: 600; }
  .empty .cta { margin-top: 8px; padding: 9px 18px; border-radius: 999px; background: var(--accent);
    color: var(--accent-ink); text-decoration: none; font-weight: 600; font-size: 13.5px; }

  @media (max-width: 820px) {
    .wrap { padding: 16px 14px 56px; }
    h1 { font-size: 25px; }
    .grid { gap: 18px 12px; grid-template-columns: repeat(auto-fill, minmax(128px, 1fr)); }
  }
</style>
