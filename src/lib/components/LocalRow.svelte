<script>
  import { onMount } from 'svelte';
  import Poster from './Poster.svelte';
  import Icon from './Icon.svelte';
  import { displayTitle } from '$lib/util.js';
  import { toast } from '$lib/stores.js';

  // A "Save to PC" download row (desktop app). kind: 'saving' (live %), 'error'
  // (failed), 'incomplete' (a leftover .part — interrupted save), 'saved' (on
  // disk, playable). film may be null until metadata resolves; fall back to "Film #id".
  let { id, film = null, kind = 'saving', pct = 0, error = null, path = null, size = null } = $props();
  let poster = $state(null);
  let busy = $state(false);
  let title = $derived(film ? displayTitle(film.title) : `Film #${id}`);
  const fmtSize = (b) => !b ? '' : (b / 1e9 >= 1 ? (b / 1e9).toFixed(1) + ' GB' : Math.round(b / 1e6) + ' MB');

  onMount(() => {
    fetch(`/api/meta/${id}?level=light`).then((r) => r.json()).then((m) => { if (m?.poster) poster = m.poster; }).catch(() => {});
  });

  async function resolvePath() {
    const core = window.__TAURI__?.core;
    const p = path || (await core?.invoke('local_file', { id }));
    if (!p) throw new Error('The saved file has gone missing.');
    return p;
  }
  async function play(e) {
    e.preventDefault(); e.stopPropagation();
    if (busy) return;
    busy = true;
    try {
      await window.__TAURI__.core.invoke('open_in_player', { url: await resolvePath(), prefer: 'mpv' });
    } catch (err) {
      toast(err?.message || 'Could not open it in mpv.', 'error');
    } finally { busy = false; }
  }
  async function reveal(e) {
    e.preventDefault(); e.stopPropagation();
    if (busy) return;
    busy = true;
    try {
      await window.__TAURI__.core.invoke('reveal_file', { path: await resolvePath() });
    } catch (err) {
      toast(err?.message || 'Could not open the folder.', 'error');
    } finally { busy = false; }
  }
</script>

<a class="row {kind}" href="/film/{id}">
  <div class="thumb"><Poster title={film?.title ?? String(id)} rank={film?.rank} src={poster} /></div>
  <div class="mid">
    <div class="t">{title}</div>
    <div class="s">
      {#if kind === 'saving'}Saving to this PC…
      {:else if kind === 'error'}Save failed
      {:else if kind === 'incomplete'}Incomplete save{size ? ' · ' + fmtSize(size) + ' so far' : ''}
      {:else}Saved on this PC{size ? ' · ' + fmtSize(size) : ''}{/if}
    </div>
    {#if kind === 'saving'}
      <div class="bar" class:indet={!pct}><span style={pct ? `width:${pct}%` : undefined}></span></div>
    {/if}
  </div>
  <div class="end">
    {#if kind === 'saving'}
      <span class="pct">{pct ? pct + '%' : '…'}</span>
    {:else if kind === 'error'}
      <span class="tag err" title={error}><Icon name="alert" size={13} stroke={2.2} /> retry on film page</span>
      <span class="go" aria-hidden="true"><Icon name="chevron" size={16} /></span>
    {:else if kind === 'incomplete'}
      <button class="icon-btn" onclick={reveal} disabled={busy} aria-label="Show in folder" title="Show in folder">
        <Icon name="folder" size={15} />
      </button>
      <span class="tag warn" title="Interrupted — open the film and hit Save to PC to resume">resume on film page</span>
      <span class="go" aria-hidden="true"><Icon name="chevron" size={16} /></span>
    {:else}
      <button class="icon-btn" onclick={reveal} disabled={busy} aria-label="Show in folder" title="Show in folder">
        <Icon name="folder" size={15} />
      </button>
      <button class="play" onclick={play} disabled={busy} title="Play the saved copy in mpv">
        <Icon name="play" size={13} stroke={2.2} /> mpv
      </button>
    {/if}
  </div>
</a>

<style>
  .row { display: flex; align-items: center; gap: 14px; padding: 10px 12px; text-decoration: none;
    color: inherit; border: 1px solid var(--border); border-radius: 12px; background: var(--surface);
    transition: border-color .14s, transform .14s; }
  .row:hover { border-color: var(--border-strong); transform: translateX(2px); }
  .thumb { width: 44px; flex: none; }
  .mid { flex: 1; min-width: 0; }
  .t { font-family: var(--font-display); font-weight: 600; font-size: 15px; line-height: 1.2;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .s { color: var(--muted); font-size: 12px; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bar { position: relative; margin-top: 8px; height: 5px; border-radius: 999px; overflow: hidden;
    background: color-mix(in srgb, var(--text) 12%, transparent); }
  .bar span { position: absolute; inset: 0 auto 0 0; display: block; height: 100%; border-radius: 999px;
    background: var(--accent); transition: width .5s ease; }
  .bar.indet span { width: 34%; animation: slide 1.3s ease-in-out infinite; }
  @keyframes slide { 0% { left: -34%; } 100% { left: 100%; } }

  .end { flex: none; display: flex; align-items: center; gap: 10px; }
  .pct { font-variant-numeric: tabular-nums; font-weight: 600; font-size: 13px; color: var(--accent);
    min-width: 42px; text-align: right; }
  .play { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 600;
    padding: 6px 12px; border-radius: 999px; border: 1px solid var(--border); background: var(--surface-2);
    color: var(--text); cursor: pointer; transition: all .14s; }
  .play:hover:not(:disabled) { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
  .play:disabled { opacity: .5; cursor: default; }
  .icon-btn { width: 32px; height: 32px; flex: none; border-radius: 999px; display: grid; place-items: center;
    border: 1px solid var(--border); background: var(--surface-2); color: var(--muted); cursor: pointer; transition: all .14s; }
  .icon-btn:hover:not(:disabled) { color: var(--text); border-color: var(--border-strong); }
  .icon-btn:disabled { opacity: .5; cursor: default; }
  .tag { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600;
    padding: 4px 9px; border-radius: 999px; white-space: nowrap; color: var(--muted);
    background: color-mix(in srgb, var(--text) 8%, transparent); }
  .tag.err { color: #e5675c; background: color-mix(in srgb, #e5675c 15%, transparent); }
  .tag.warn { color: #d99a2b; background: color-mix(in srgb, #d99a2b 16%, transparent); }
  .go { color: var(--faint); display: grid; place-items: center; }
  .row:hover .go { color: var(--muted); }
</style>
