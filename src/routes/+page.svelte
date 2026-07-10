<script>
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import FilmCard from '$lib/components/FilmCard.svelte';
  import { toast } from '$lib/stores.js';

  let { data } = $props();

  let items = $state(data.films);
  let total = $state(data.total);
  let loading = $state(false);
  let sentinel;

  $effect(() => { items = data.films; total = data.total; });

  const sortValue = () => `${data.filters?.sort || 'rank'}|${data.filters?.order || 'asc'}`;

  function onSort(e) {
    const [sort, order] = e.target.value.split('|');
    const p = new URLSearchParams(data.filters);
    p.set('sort', sort); p.set('order', order); p.delete('offset');
    goto('/?' + p.toString(), { noScroll: true, keepFocus: true });
  }

  async function loadMore() {
    if (loading || items.length >= total) return;
    loading = true;
    const sig = JSON.stringify(data.filters);
    const offsetAt = items.length;
    const p = new URLSearchParams(data.filters);
    p.set('offset', offsetAt); p.set('limit', 60);
    try {
      const r = await fetch('/api/films?' + p.toString());
      if (!r.ok) throw new Error('bad status');
      const d = await r.json();
      // discard if filters changed OR the list moved (A->B->A) since we requested
      if (sig !== JSON.stringify(data.filters) || items.length !== offsetAt) return;
      if (Array.isArray(d.items)) {
        const seen = new Set(items.map((x) => x.id_tspdt));
        items = [...items, ...d.items.filter((x) => !seen.has(x.id_tspdt))];
      }
    } catch {
      toast('Could not load more titles — check the connection.', 'error');
    } finally { loading = false; }
  }

  function onStatus(id, status) {
    const active = data.filters?.status;
    if (active && status !== active) { items = items.filter((x) => x.id_tspdt !== id); total = Math.max(0, total - 1); }
  }

  onMount(() => {
    const io = new IntersectionObserver((es) => { if (es[0].isIntersecting) loadMore(); }, { rootMargin: '900px' });
    io.observe(sentinel);
    return () => io.disconnect();
  });
</script>

<svelte:head><title>Film Index · {data.facets.latestEdition} ranking</title></svelte:head>

<div class="results-bar">
  <div class="rb-count">{total.toLocaleString()} <span>titles</span></div>
  <label class="rb-sort">
    Sort
    <select class="ctl" onchange={onSort} value={sortValue()}>
      <option value="rank|asc">Ranking (best first)</option>
      <option value="rank|desc">Ranking (lowest first)</option>
      <option value="year|desc">Year (newest)</option>
      <option value="year|asc">Year (oldest)</option>
      <option value="title|asc">Title (A–Z)</option>
    </select>
  </label>
</div>

<main class="grid-wrap">
  {#if items.length === 0}
    <p class="empty">No titles match these filters.</p>
  {:else}
    <div class="grid">
      {#each items as film (film.id_tspdt)}
        <FilmCard {film} onstatus={onStatus} postersEnabled={data.meta?.tmdb} />
      {/each}
    </div>
  {/if}
  <div class="sentinel" bind:this={sentinel}></div>
  {#if loading}<div class="loading"><span></span><span></span><span></span></div>{/if}
</main>

<style>
  .results-bar { position: sticky; top: 0; z-index: 20; display: flex; align-items: center;
    justify-content: space-between; gap: 16px; padding: 18px 30px;
    background: color-mix(in srgb, var(--bg) 82%, transparent); backdrop-filter: blur(10px);
    border-bottom: 1px solid var(--border); }
  .rb-count { font-family: var(--font-display); font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .rb-count span { color: var(--muted); font-size: 14px; font-family: var(--font-sans); font-weight: 400; }
  .rb-sort { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 13px; }

  .grid-wrap { padding: 26px 30px 60px; }
  .grid { display: grid; gap: 26px 20px; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); }
  .empty { text-align: center; color: var(--muted); padding: 90px 0; }
  .sentinel { height: 1px; }
  .loading { display: flex; gap: 7px; justify-content: center; padding: 34px; }
  .loading span { width: 9px; height: 9px; border-radius: 999px; background: var(--accent);
    animation: b 1s infinite ease-in-out; }
  .loading span:nth-child(2) { animation-delay: .15s; } .loading span:nth-child(3) { animation-delay: .3s; }
  @keyframes b { 0%,80%,100% { transform: scale(.5); opacity: .4; } 40% { transform: scale(1); opacity: 1; } }

  @media (max-width: 820px) {
    /* Not sticky on mobile — the top app bar is the only pinned chrome, so the
       two don't fight over the top edge. */
    .results-bar { position: static; padding: 13px 16px; }
    .rb-count { font-size: 19px; }
    .rb-sort .ctl { font-size: 16px; }   /* 16px: no iOS focus-zoom */
    .grid-wrap { padding: 16px 14px 56px; }
    .grid { gap: 18px 12px; grid-template-columns: repeat(auto-fill, minmax(128px, 1fr)); }
    .empty { padding: 64px 0; }
  }
</style>
