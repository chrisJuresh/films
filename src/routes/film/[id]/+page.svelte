<script>
  import Poster from '$lib/components/Poster.svelte';
  import Sparkline from '$lib/components/Sparkline.svelte';
  import { displayTitle, gradientFor, colourLabel } from '$lib/util.js';
  import { counts, toast } from '$lib/stores.js';

  let { data } = $props();
  let film = $derived(data.film);

  let status = $state(data.film.status ?? null);      // site status: watchlist | seen | null
  let lbState = $state(data.film.lb_state ?? null);   // letterboxd: watched | unwatched | null
  let meta = $state(null);    // IMDb/TMDB enrichment

  let loadedId;
  $effect(() => {
    const id = film.id_tspdt;
    status = film.status ?? null; lbState = film.lb_state ?? null;
    if (loadedId === id) return;
    loadedId = id; meta = null;
    fetch(`/api/meta/${id}`).then((r) => r.json())
      .then((mm) => { if (loadedId === id) meta = mm; }).catch(() => { if (loadedId === id) meta = { enabled: false }; });
  });

  let ready = $derived(meta && meta.enabled !== false);
  let watchlisted = $derived(status === 'watchlist');
  let lbWatched = $derived(lbState === 'watched');
  let seen = $derived(status === 'seen' || lbWatched);
  // Age ratings: freshest from live enrichment, else the queryable film_cert set.
  let certs = $derived((ready && meta?.certifications?.length) ? meta.certifications : (film.certs || []));

  // Watch / Download are intentionally open-ended: this app does NOT decide what
  // they do. A click emits the film's stable identifiers so anything else can act
  // on it — an API client, a companion app/service, a userscript, a home-media
  // server, etc. Two integration seams, tried in order:
  //   1) window.filmsHandleAction(detail)   — assign a function to handle it.
  //   2) a cancelable "films:action" CustomEvent dispatched on window; a listener
  //      calls detail's event.preventDefault() to signal it handled the action.
  // detail = { action, id_tspdt, imdb_id, imdb_url, tmdb_id, title, year }.
  function filmAction(action) {
    const detail = {
      action,                                   // 'watch' | 'download'
      id_tspdt: film.id_tspdt,
      imdb_id: film.imdb_id ?? null,
      imdb_url: film.imdb_url ?? null,
      tmdb_id: (ready && meta?.tmdb_id) || null,
      title: displayTitle(film.title),
      year: film.year ?? null
    };
    if (typeof window.filmsHandleAction === 'function') {
      try { window.filmsHandleAction(detail); return; } catch { /* fall through to the event */ }
    }
    const handled = !window.dispatchEvent(
      new CustomEvent('films:action', { detail, bubbles: true, cancelable: true })
    );
    if (!handled) toast(`No “${action}” handler is wired up yet.`, 'info', 3200);
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

  const money = (n) => (n ? '$' + Number(n).toLocaleString() : null);
  let director = $derived((ready && meta.directors?.length ? meta.directors.join(', ') : film.director));
  let runtime = $derived((ready && meta.runtime) || film.length_min);
  let genres = $derived(ready && meta.genres?.length ? meta.genres
    : (film.genre && film.genre !== '---' ? film.genre.split('-') : []));
</script>

<svelte:head><title>{displayTitle(film.title)} ({film.year}) · Film Index</title></svelte:head>

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

      <div class="ratings">
        {#if ready && meta.imdb_rating}
          <a class="rt-badge imdb" href={meta.imdb_url} target="_blank" rel="noopener" title="{meta.imdb_votes} votes on IMDb">
            <b>IMDb</b><span>★ {meta.imdb_rating}</span>
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
        {#each certs as c}<span class="chip cert" title="Age rating · {c.country}">{c.country} {c.cert}</span>{/each}
      </div>

      <div class="cta">
        <button class="btn primary" onclick={() => filmAction('watch')}>▶ Watch</button>
        <button class="btn" onclick={() => filmAction('download')}>⬇ Download</button>
        {#if ready && meta.trailer}<a class="btn" href={meta.trailer} target="_blank" rel="noopener">▷ Trailer</a>{/if}
      </div>

      <div class="actions">
        <button class="ghost" class:on={watchlisted} onclick={toggleWatchlist}>{watchlisted ? '♥ On watchlist' : '♥ Watchlist'}</button>
        <button class="ghost seen" class:on={seen} class:lb={lbWatched} onclick={toggleSeen}>{seen ? (lbWatched ? '✓ Seen · Letterboxd' : '✓ Seen') : '✓ Mark seen'}</button>
      </div>
    </div>
  </div>

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
  .chip.cert { border-color: var(--border-strong); color: var(--text); font-variant-numeric: tabular-nums; letter-spacing: .01em; }

  .cta { display: flex; gap: 12px; flex-wrap: wrap; }
  .btn { padding: 13px 22px; border-radius: 12px; border: 1px solid var(--border-strong); background: var(--surface-2);
    color: var(--text); font-size: 15px; font-weight: 600; cursor: pointer; font-family: inherit; text-decoration: none;
    display: inline-flex; align-items: center; transition: transform .12s, border-color .12s; }
  .btn:hover:not(:disabled) { border-color: var(--accent); transform: translateY(-1px); }
  .btn:disabled { opacity: .55; cursor: progress; }
  .btn.primary { background: linear-gradient(120deg, var(--accent), color-mix(in srgb, var(--accent) 70%, #d98324));
    color: var(--accent-ink); border: none; box-shadow: 0 8px 24px color-mix(in srgb, var(--accent) 30%, transparent); }

  .actions { display: flex; gap: 10px; margin-top: 18px; }
  .ghost { padding: 9px 15px; border-radius: 10px; border: 1px solid var(--border); background: transparent;
    color: var(--text); font-size: 13.5px; cursor: pointer; font-family: inherit; transition: all .12s; }
  .ghost:hover { border-color: var(--border-strong); }
  .ghost.on { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
  .ghost.seen.on { background: var(--free); color: #06210b; border-color: var(--free); }
  .ghost.seen.on.lb { background: var(--lb); color: var(--lb-ink); border-color: var(--lb); }

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
