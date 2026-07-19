<script>
  import { goto } from '$app/navigation';
  import Icon from './Icon.svelte';
  import { gradientFor } from '$lib/util.js';
  import { toast } from '$lib/stores.js';

  let { open = false, onclose = () => {} } = $props();
  let q = $state('');
  let items = $state([]);
  let loading = $state(false);
  let searched = $state(false);
  let message = $state('');
  let adding = $state(null);
  let input = $state();
  let timer;
  let controller;

  $effect(() => {
    if (!open) return;
    const prior = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusTimer = setTimeout(() => input?.focus(), 30);
    return () => {
      clearTimeout(focusTimer);
      document.body.style.overflow = prior;
      controller?.abort();
    };
  });

  function close() {
    controller?.abort();
    clearTimeout(timer);
    onclose();
  }

  function keydown(e) { if (open && e.key === 'Escape') close(); }

  function onQuery(e) {
    q = e.target.value;
    message = '';
    searched = false;
    clearTimeout(timer);
    controller?.abort();
    if (q.trim().length < 2) { items = []; loading = false; return; }
    loading = true;
    const term = q.trim();
    timer = setTimeout(() => search(term), 280);
  }

  async function search(term) {
    controller = new AbortController();
    try {
      const response = await fetch('/api/manual-films?q=' + encodeURIComponent(term), { signal: controller.signal });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.message || 'Movie search failed.');
      if (q.trim() !== term) return;
      items = Array.isArray(data.items) ? data.items : [];
      searched = true;
    } catch (cause) {
      if (cause?.name === 'AbortError') return;
      items = [];
      searched = true;
      message = cause?.message || 'Movie search failed.';
    } finally {
      if (q.trim() === term) loading = false;
    }
  }

  async function add(movie) {
    if (adding != null) return;
    adding = movie.tmdb_id;
    message = '';
    try {
      const response = await fetch('/api/manual-films', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tmdb_id: movie.tmdb_id })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.message || 'The film could not be added.');
      close();
      toast(data.created ? `Added “${movie.title}” to Film Index.` : `“${movie.title}” is already in Film Index.`, data.created ? 'ok' : 'info');
      await goto(`/film/${data.id}`, { invalidateAll: true });
    } catch (cause) {
      message = cause?.message || 'The film could not be added.';
    } finally { adding = null; }
  }
</script>

<svelte:window onkeydown={keydown} />

{#if open}
  <button class="scrim" onclick={close} aria-label="Close add-film dialog"></button>
  <dialog open class="dialog" aria-labelledby="add-film-title">
    <header>
      <div>
        <h2 id="add-film-title">Add a film</h2>
        <p>Find any movie that isn’t already in Film Index.</p>
      </div>
      <button class="close" onclick={close} aria-label="Close"><Icon name="x" size={17} /></button>
    </header>

    <div class="finder">
      <Icon name={loading ? 'sync' : 'search'} size={18} spin={loading} />
      <input bind:this={input} type="search" value={q} oninput={onQuery}
             placeholder="Search by movie title" autocomplete="off" aria-label="Movie title" />
      <kbd>esc</kbd>
    </div>

    {#if q.trim().length < 2}
      <div class="welcome">
        <span class="mark"><Icon name="diamond" size={20} /></span>
        <p>Search TMDB, then add the exact film you want.</p>
        <small>It gets a full film page and works with your lists, downloads and playback.</small>
      </div>
    {:else}
      <div class="result-label"><span>Movies</span><span>Results from TMDB</span></div>
      <div class="results" aria-live="polite">
        {#if message}
          <div class="state error"><Icon name="alert" size={16} /> {message}</div>
        {:else if loading && !items.length}
          <div class="state"><Icon name="sync" size={16} spin /> Searching…</div>
        {:else if searched && !items.length}
          <div class="state">No matching movies found.</div>
        {:else}
          {#each items as movie (movie.tmdb_id)}
            <article class="result">
              <div class="poster" style={!movie.poster ? `background:${gradientFor(movie.title)}` : undefined}>
                {#if movie.poster}<img src={movie.poster} alt="" />{:else}<span>{movie.title}</span>{/if}
              </div>
              <div class="copy">
                <h3>{movie.title}</h3>
                <div class="meta">{movie.year || 'Year unknown'}{movie.original_title ? ' · ' + movie.original_title : ''}</div>
                {#if movie.overview}<p>{movie.overview}</p>{/if}
              </div>
              {#if movie.existing_id != null}
                <a class="existing" href="/film/{movie.existing_id}" onclick={close}><Icon name="check" size={12} stroke={2.5} /> Added</a>
              {:else}
                <button class="add" onclick={() => add(movie)} disabled={adding != null} aria-label="Add {movie.title}">
                  <Icon name={adding === movie.tmdb_id ? 'sync' : 'plus'} size={14} spin={adding === movie.tmdb_id} />
                  <span>{adding === movie.tmdb_id ? 'Adding…' : 'Add'}</span>
                </button>
              {/if}
            </article>
          {/each}
        {/if}
      </div>
    {/if}

    <footer><i></i>If a future TSPDT edition includes it, the manual entry merges into its official ranking automatically.</footer>
  </dialog>
{/if}

<style>
  .scrim { position: fixed; inset: 0; z-index: 200; border: 0; padding: 0; background: rgba(2,3,6,.74);
    backdrop-filter: blur(4px); cursor: default; }
  .dialog { position: fixed; z-index: 201; left: 50%; top: 50%; transform: translate(-50%,-50%);
    width: min(680px, calc(100vw - 36px)); max-height: min(760px, calc(100vh - 50px)); overflow: hidden;
    display: flex; flex-direction: column; border: 1px solid var(--border-strong); border-radius: 18px;
    margin: 0; padding: 0; color: var(--text); background: color-mix(in srgb, var(--surface) 78%, var(--bg));
    box-shadow: 0 32px 100px rgba(0,0,0,.72); }
  header { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; padding: 24px 24px 18px; }
  h2 { margin: 0; font: 600 26px/1.1 var(--font-display); }
  header p { margin: 7px 0 0; color: var(--muted); font-size: 13px; }
  .close { width: 34px; height: 34px; display: grid; place-items: center; flex: none; border: 1px solid var(--border);
    border-radius: 9px; background: var(--surface); color: var(--muted); cursor: pointer; }
  .close:hover { color: var(--text); border-color: var(--border-strong); }
  .finder { margin: 0 24px; position: relative; }
  .finder > :global(.icon) { position: absolute; z-index: 1; left: 14px; top: 50%; transform: translateY(-50%); color: var(--muted); }
  .finder input { width: 100%; padding: 13px 44px 13px 43px; border: 1px solid var(--accent); border-radius: 11px;
    background: var(--surface); color: var(--text); font-size: 15px; outline: 0;
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 12%, transparent); }
  .finder kbd { position: absolute; right: 13px; top: 50%; transform: translateY(-50%); padding: 3px 6px;
    border: 1px solid var(--border); border-radius: 5px; background: var(--surface-2); color: var(--faint); font-size: 10px; }
  .welcome { min-height: 250px; padding: 48px 24px; display: flex; flex-direction: column; align-items: center;
    justify-content: center; text-align: center; color: var(--muted); }
  .welcome .mark { width: 50px; height: 50px; display: grid; place-items: center; border-radius: 15px;
    color: var(--accent); border: 1px solid var(--border); background: var(--surface); }
  .welcome p { margin: 15px 0 5px; color: var(--text); font: 600 16px var(--font-display); }
  .welcome small { max-width: 430px; color: var(--faint); line-height: 1.45; }
  .result-label { display: flex; justify-content: space-between; padding: 19px 24px 10px; color: var(--faint);
    font-size: 11px; letter-spacing: .12em; text-transform: uppercase; }
  .result-label span:last-child { text-transform: none; letter-spacing: 0; }
  .results { flex: 1 1 auto; min-height: 110px; padding: 0 12px 14px; overflow-y: auto; }
  .result { display: grid; grid-template-columns: 52px minmax(0,1fr) auto; align-items: center; gap: 13px;
    padding: 10px 12px; border: 1px solid transparent; border-radius: 11px; }
  .result:hover { background: var(--surface); border-color: var(--border); }
  .poster { width: 52px; height: 72px; display: flex; overflow: hidden; align-items: center; justify-content: center;
    border-radius: 7px; box-shadow: 0 7px 20px rgba(0,0,0,.38); }
  .poster img { width: 100%; height: 100%; object-fit: cover; }
  .poster span { padding: 5px; text-align: center; color: #f4efe4; font: 600 9px/1.15 var(--font-display); }
  .copy { min-width: 0; }
  h3 { margin: 0; font: 600 16px/1.2 var(--font-display); }
  .meta { margin-top: 4px; color: var(--muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .copy p { margin: 6px 0 0; color: var(--faint); font-size: 12px; line-height: 1.35; display: -webkit-box;
    -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .add, .existing { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 8px 11px;
    border-radius: 8px; font-size: 12px; font-weight: 700; white-space: nowrap; text-decoration: none; }
  .add { border: 1px solid var(--accent); background: transparent; color: var(--accent); cursor: pointer; }
  .add:hover:not(:disabled) { background: var(--accent); color: var(--accent-ink); }
  .add:disabled { opacity: .62; cursor: default; }
  .existing { border: 1px solid var(--border); background: var(--surface-2); color: var(--faint); }
  .existing:hover { color: var(--text); border-color: var(--border-strong); }
  .state { min-height: 130px; display: flex; align-items: center; justify-content: center; gap: 8px; color: var(--muted); font-size: 13px; }
  .state.error { color: #e98378; }
  footer { display: flex; align-items: center; gap: 8px; padding: 14px 24px 16px; border-top: 1px solid var(--border);
    color: var(--faint); font-size: 11.5px; line-height: 1.4; }
  footer i { width: 5px; height: 5px; flex: none; border-radius: 50%; background: var(--accent); }

  @media (max-width: 820px) {
    .dialog { left: 0; right: 0; top: auto; bottom: 0; transform: none; width: 100%; max-height: 88dvh;
      border-radius: 20px 20px 0 0; border-left: 0; border-right: 0; border-bottom: 0; }
    header { position: relative; padding: 23px 18px 15px; }
    header::before { content: ''; position: absolute; left: 50%; top: 8px; width: 44px; height: 4px;
      transform: translateX(-50%); border-radius: 9px; background: var(--border-strong); }
    h2 { font-size: 24px; }
    .finder { margin: 0 18px; }
    .finder input { font-size: 16px; }
    .result-label { padding: 18px 18px 8px; }
    .results { padding: 0 7px 12px; }
    .result { grid-template-columns: 46px minmax(0,1fr) auto; gap: 10px; padding: 9px 10px; }
    .poster { width: 46px; height: 66px; }
    h3 { font-size: 15px; }
    .copy p { display: none; }
    .add { width: 36px; height: 36px; padding: 0; }
    .add span { display: none; }
    .existing { width: 36px; height: 36px; padding: 0; font-size: 0; }
    .existing :global(.icon) { width: 14px; height: 14px; }
    .welcome { min-height: 210px; padding: 36px 20px; }
    footer { padding: 12px 18px 15px; }
  }
</style>
