<script>
  import { onMount } from 'svelte';
  import Poster from './Poster.svelte';
  import Icon from './Icon.svelte';
  import { displayTitle } from '$lib/util.js';
  import { toast } from '$lib/stores.js';

  // One line in the tracker for an in-flight film. kind drives the right-hand
  // status/action: 'downloading' (progress + cancel), 'wanted' (searching),
  // 'error' (needs attention). The whole row links to the film page.
  let { film, kind = 'downloading', postersEnabled = false, oncancel = () => {} } = $props();
  let poster = $state(null);
  let busy = $state(false);
  let pct = $derived(film.download_progress ?? null);

  onMount(() => {
    if (!postersEnabled || !film.imdb_id) return;
    fetch(`/api/meta/${film.id_tspdt}?level=light`)
      .then((r) => r.json())
      .then((m) => { if (m?.poster) poster = m.poster; })
      .catch(() => {});
  });

  async function cancel(e) {
    e.preventDefault(); e.stopPropagation();
    if (busy) return;
    if (!confirm(`Cancel “${displayTitle(film.title)}”?\n\nIt's removed from Radarr's queue and the download client.`)) return;
    busy = true;
    try {
      const r = await fetch(`/api/radarr/${film.id_tspdt}`, { method: 'DELETE' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.message || '');
      toast('Download cancelled.', 'info');
      oncancel(film.id_tspdt);
    } catch (err) {
      toast(err?.message || 'Could not cancel the download.', 'error');
      busy = false;
    }
  }
</script>

<a class="row {kind}" href="/film/{film.id_tspdt}">
  <div class="thumb"><Poster title={film.title} rank={film.rank} src={poster} /></div>
  <div class="mid">
    <div class="t">{displayTitle(film.title)}</div>
    <div class="s">#{film.rank}{film.year ? ' · ' + film.year : ''}{film.director ? ' · ' + film.director : ''}</div>
    {#if kind === 'downloading'}
      <div class="bar" class:indet={pct == null}><span style={pct == null ? undefined : `width:${pct}%`}></span></div>
    {/if}
  </div>
  <div class="end">
    {#if kind === 'downloading'}
      <span class="pct">{pct != null ? pct + '%' : 'Downloading'}</span>
      <button class="cancel" onclick={cancel} disabled={busy} aria-label="Cancel download" title="Cancel download">
        <Icon name="x" size={15} stroke={2.2} />
      </button>
    {:else if kind === 'wanted'}
      <span class="tag want"><span class="dot"></span> Searching</span>
      <span class="go" aria-hidden="true"><Icon name="chevron" size={16} /></span>
    {:else}
      <span class="tag err"><Icon name="alert" size={13} stroke={2.2} /> Needs a release</span>
      <span class="go" aria-hidden="true"><Icon name="chevron" size={16} /></span>
    {/if}
  </div>
</a>

<style>
  .row { display: flex; align-items: center; gap: 14px; padding: 10px 12px; text-decoration: none;
    color: inherit; border: 1px solid var(--border); border-radius: 12px; background: var(--surface);
    transition: border-color .14s, transform .14s, background .14s; }
  .row:hover { border-color: var(--border-strong); transform: translateX(2px); }
  .thumb { width: 44px; flex: none; }
  .mid { flex: 1; min-width: 0; }
  .t { font-family: var(--font-display); font-weight: 600; font-size: 15px; line-height: 1.2;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .s { color: var(--muted); font-size: 12px; margin-top: 2px; white-space: nowrap; overflow: hidden;
    text-overflow: ellipsis; }
  .bar { position: relative; margin-top: 8px; height: 5px; border-radius: 999px; overflow: hidden;
    background: color-mix(in srgb, var(--text) 12%, transparent); }
  .bar span { position: absolute; inset: 0 auto 0 0; display: block; height: 100%; border-radius: 999px;
    background: #2f7de1; transition: width .6s ease; }
  /* No percentage yet (just handed off / verifying): a moving sliver. */
  .bar.indet span { width: 34%; animation: slide 1.3s ease-in-out infinite; }
  @keyframes slide { 0% { left: -34%; } 100% { left: 100%; } }

  .end { flex: none; display: flex; align-items: center; gap: 10px; }
  .pct { font-variant-numeric: tabular-nums; font-weight: 600; font-size: 13px; color: #4a90e2;
    min-width: 42px; text-align: right; }
  .cancel { width: 30px; height: 30px; flex: none; border-radius: 999px; display: grid; place-items: center;
    border: 1px solid var(--border); background: var(--surface-2); color: var(--muted); cursor: pointer;
    transition: all .14s; }
  .cancel:hover:not(:disabled) { color: #fff; background: #e5675c; border-color: #e5675c; }
  .cancel:disabled { opacity: .5; cursor: default; }
  .tag { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600;
    padding: 4px 9px; border-radius: 999px; white-space: nowrap; }
  .tag.want { color: var(--muted); background: color-mix(in srgb, var(--text) 8%, transparent); }
  .tag.err { color: #e5675c; background: color-mix(in srgb, #e5675c 15%, transparent); }
  .dot { width: 7px; height: 7px; border-radius: 999px; background: #9aa3ad; animation: pulse 1.4s ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .25; } }
  .go { color: var(--faint); display: grid; place-items: center; }
  .row:hover .go { color: var(--muted); }
</style>
