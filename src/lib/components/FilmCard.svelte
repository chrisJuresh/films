<script>
  import { onMount } from 'svelte';
  import Poster from './Poster.svelte';
  import { displayTitle } from '$lib/util.js';
  import { counts, toast } from '$lib/stores.js';

  let { film, onstatus = () => {}, postersEnabled = false } = $props();
  let status = $state(film.status ?? null);
  let poster = $state(null);

  // Pull real poster art (TMDB) for this card. Rendering is already bounded to
  // ~60 cards per page by the grid's infinite scroll, so a per-card fetch is fine.
  onMount(() => {
    if (!postersEnabled || !film.imdb_id) return;
    fetch(`/api/meta/${film.id_tspdt}?level=light`)
      .then((r) => r.json())
      .then((m) => { if (m?.poster) poster = m.poster; })
      .catch(() => {});
  });

  async function set(next, e) {
    e.preventDefault(); e.stopPropagation();
    const want = status === next ? null : next;
    try {
      const res = await fetch('/api/status', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id_tspdt: film.id_tspdt, status: want })
      });
      if (!res.ok) throw new Error();
      const data = await res.json();
      status = data.status;
      if (data.counts) counts.set(data.counts);
      onstatus(film.id_tspdt, want);
    } catch { toast('Could not update your list.', 'error'); }
  }
</script>

<a class="card" href="/film/{film.id_tspdt}">
  <div class="pw">
    <Poster title={film.title} rank={film.rank} src={poster} />
    <span class="rank">#{film.rank}</span>
    {#if film.is_new}<span class="badge new">NEW</span>{/if}
    <div class="acts">
      <button class="act" class:on={status === 'watchlist'} onclick={(e) => set('watchlist', e)} aria-label="Add to watchlist" title="Watchlist">♥</button>
      <button class="act seen" class:on={status === 'seen'} onclick={(e) => set('seen', e)} aria-label="Mark seen" title="Seen">✓</button>
    </div>
  </div>
  <div class="meta">
    <div class="t">{displayTitle(film.title)}</div>
    <div class="s">{film.year ?? ''}{film.director ? ' · ' + film.director : ''}</div>
  </div>
</a>

<style>
  .card { display: block; text-decoration: none; color: inherit; }
  .pw { position: relative; transition: transform .2s; }
  .card:hover .pw { transform: translateY(-6px); }
  .card :global(.poster) { transition: box-shadow .2s, border-color .2s; }
  .card:hover :global(.poster) { box-shadow: 0 20px 50px rgba(0,0,0,.55); border-color: var(--border-strong); }
  .rank { position: absolute; top: 9px; left: 9px; z-index: 2; background: var(--accent);
    color: var(--accent-ink); font-weight: 700; font-size: 12.5px; padding: 3px 8px;
    border-radius: 7px; font-variant-numeric: tabular-nums; box-shadow: 0 2px 8px rgba(0,0,0,.4); }
  .badge { position: absolute; top: 9px; right: 9px; z-index: 2; font-size: 10px; font-weight: 700;
    letter-spacing: .05em; padding: 3px 7px; border-radius: 6px; }
  .badge.new { background: color-mix(in srgb, var(--accent) 34%, #000 24%); color: #fff; }
  .acts { position: absolute; inset: auto 0 0 0; z-index: 3; display: flex; gap: 8px;
    justify-content: center; padding: 12px; border-radius: 0 0 14px 14px;
    background: linear-gradient(transparent, rgba(0,0,0,.8)); opacity: 0; transform: translateY(8px);
    transition: all .18s; }
  .card:hover .acts { opacity: 1; transform: none; }
  .act { width: 38px; height: 38px; border-radius: 999px; border: 1px solid rgba(255,255,255,.28);
    background: rgba(18,18,22,.72); color: #fff; font-size: 15px; cursor: pointer; display: grid;
    place-items: center; backdrop-filter: blur(4px); transition: transform .14s, background .14s; }
  .act:hover { transform: scale(1.12); }
  .act.on { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
  .act.seen.on { background: var(--free); color: #06210b; border-color: var(--free); }
  .meta { padding: 10px 2px 0; }
  .t { font-family: var(--font-display); font-weight: 600; font-size: 14.5px; line-height: 1.22;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .s { color: var(--muted); font-size: 12px; margin-top: 3px; white-space: nowrap; overflow: hidden;
    text-overflow: ellipsis; }

  /* Touch devices have no hover to reveal the actions, so show them always.
     Mouse (hover:hover) devices are unaffected — desktop is unchanged. */
  @media (hover: none) {
    .acts { opacity: 1; transform: none; }
    .card:active .pw { transform: scale(.985); }
  }
</style>
