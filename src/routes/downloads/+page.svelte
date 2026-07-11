<script>
  import { onMount } from 'svelte';
  import { invalidateAll } from '$app/navigation';
  import FilmCard from '$lib/components/FilmCard.svelte';
  import DownloadRow from '$lib/components/DownloadRow.svelte';
  import Icon from '$lib/components/Icon.svelte';

  let { data } = $props();

  // Counts come from the layout load (data.downloads); the four lists from this
  // page's load. Locally-cancelled ids are filtered until Radarr's snapshot
  // catches up (its 45s TTL can otherwise briefly resurrect a cancelled row).
  let cancelled = $state(new Set());
  let downloading = $derived(data.downloading.filter((f) => !cancelled.has(f.id_tspdt)));
  let wanted = $derived(data.wanted);
  let errored = $derived(data.errored);
  let downloaded = $derived(data.downloaded);
  let counts = $derived(data.downloads || { downloaded: 0, downloading: 0, wanted: 0, error: 0 });
  let total = $derived(downloading.length + wanted.length + errored.length + downloaded.length);
  let postersEnabled = $derived(!!data.meta?.tmdb);

  function onCancel(id) { cancelled = new Set([...cancelled, id]); invalidateAll(); }

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

  {#if total === 0}
    <div class="empty">
      <Icon name="download" size={30} />
      <p>Nothing downloading yet.</p>
      <span>Open a film and hit <em>Download</em> — it'll show up here while Radarr fetches it.</span>
      <a class="cta" href="/">Browse the catalogue</a>
    </div>
  {:else}
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
  .hint { color: var(--muted); font-size: 13px; margin: -4px 0 12px; }
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
