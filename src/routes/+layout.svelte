<script>
  import '../app.css';
  import { onMount } from 'svelte';
  import { browser } from '$app/environment';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { counts as countsStore, theme, initDownloadTracker, initMpvProgress } from '$lib/stores.js';
  import { colourLabel } from '$lib/util.js';
  import Toast from '$lib/components/Toast.svelte';
  import Icon from '$lib/components/Icon.svelte';

  let { data, children } = $props();

  // Film detail pages are full-bleed — no sidebar.
  let onFilm = $derived($page.url.pathname.startsWith('/film/'));

  $effect(() => { if (data?.counts) countsStore.set(data.counts); });

  let q = $state('');
  let countryQuery = $state('');
  let themeName = $state('dark');
  let searchFocused = $state(false);
  let menuOpen = $state(false);          // mobile filter drawer
  let isTauri = $state(browser && !!window.__TAURI__?.core?.invoke);   // desktop app? (sync — no flash)
  let update = $state(null);             // { available, latest, url } from GitHub releases

  const closeMenu = () => (menuOpen = false);

  // Lock background scroll while the drawer is open (mobile only).
  $effect(() => {
    document.body.style.overflow = menuOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  });

  // Sync the box from the URL (tab links, back/forward) — but never while the
  // user is actively typing, or their keystrokes would be clobbered.
  $effect(() => {
    const urlQ = $page.url.searchParams.get('q') || '';
    if (!searchFocused) q = urlQ;
  });
  onMount(() => {
    const t = localStorage.getItem('tspdt-theme') || 'dark';
    themeName = t; document.documentElement.dataset.theme = t;
    // If the drawer is open and the viewport grows to desktop, close it so the
    // scroll lock is released and the sidebar reverts to its docked layout.
    const mq = window.matchMedia('(min-width: 821px)');
    const onWide = (e) => { if (e.matches) menuOpen = false; };
    mq.addEventListener('change', onWide);
    // Desktop app: surface an update if GitHub has a newer release.
    const tauri = window.__TAURI__;
    if (tauri?.core?.invoke) {
      tauri.core.invoke('check_update').then((u) => { update = u; }).catch(() => {});
      initDownloadTracker();   // track "Save to PC" progress app-wide
      initMpvProgress();       // report mpv playback position back → "watched %"
    }
    return () => mq.removeEventListener('change', onWide);
  });
  function openRelease() {
    const url = update?.url || 'https://github.com/chrisJuresh/films/releases/latest';
    window.__TAURI__?.core?.invoke('open_in_player', { url, prefer: 'default' }).catch(() => {});
  }

  const sel = (key) => ($page.url.searchParams.get(key) || '').split(',').filter(Boolean);
  const isSel = (key, val) => sel(key).includes(String(val));
  const statusNow = () => $page.url.searchParams.get('status') || '';
  const radarrNow = () => $page.url.searchParams.get('radarr') || '';

  function navigate(patch) {
    const p = new URLSearchParams($page.url.searchParams);
    for (const [k, v] of Object.entries(patch)) {
      const val = Array.isArray(v) ? v.join(',') : v;
      if (!val) p.delete(k); else p.set(k, val);
    }
    p.delete('offset');
    try { localStorage.setItem('tspdt-filters', p.toString()); } catch {}   // survive leaving + returning
    goto('/?' + p.toString(), { keepFocus: true, noScroll: true });
  }
  function toggle(key, val) {
    const cur = new Set(sel(key));
    const s = String(val);
    cur.has(s) ? cur.delete(s) : cur.add(s);
    navigate({ [key]: [...cur] });
  }

  let searchTimer;
  function onSearch(e) {
    q = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => navigate({ q: q.trim() }), 240);
  }

  let activeCount = $derived(
    ['q', 'decade', 'genre', 'country', 'colour', 'maxage', 'radarr', 'new'].reduce(
      (n, k) => n + (($page.url.searchParams.get(k) || '') ? 1 : 0), 0)
  );
  function clearAll() { navigate({ q: '', decade: '', genre: '', country: '', colour: '', maxage: '', radarr: '', new: '' }); }

  let userEmail = $derived(data?.user || null);
  let dl = $derived(data?.downloads);
  let hasDownloads = $derived(!!(dl && (dl.downloaded || dl.downloading || dl.wanted || dl.error)));

  // Public demo: no login, no library, no acquisition. The server already
  // refuses those routes (hooks.server.js); this only removes the affordances.
  let demo = $derived(!!data?.demo);
  let github = $derived(data?.github || 'https://github.com/chrisJuresh/films');
  const TSPDT_URL = 'https://theyshootpictures.com';

  // Age-rating slider. maxage = highest rating age to show; 18 = off (everything,
  // including unrated). A film's age is its most-restrictive country rating, so
  // nothing unsuitable slips into a lower bracket.
  let ageLive = $state(18);
  $effect(() => {
    const v = parseInt($page.url.searchParams.get('maxage') ?? '', 10);
    ageLive = Number.isNaN(v) ? 18 : v;
  });
  let ageLabel = $derived(ageLive >= 18 ? 'All films' : ageLive <= 0 ? 'All-ages only' : `Up to age ${ageLive}`);
  let ageCount = $derived((data.facets?.ages || []).reduce((n, a) => n + (a.age <= ageLive ? a.count : 0), 0));
  function onAgeInput(e) { ageLive = +e.target.value; }
  function onAgeCommit() { navigate({ maxage: ageLive >= 18 ? '' : String(ageLive) }); }

  function toggleTheme() {
    themeName = themeName === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = themeName;
    localStorage.setItem('tspdt-theme', themeName);
  }

  let countriesShown = $derived(
    (data.facets?.countries || []).filter((c) => c.value.toLowerCase().includes(countryQuery.toLowerCase()))
  );
</script>

{#if demo}
<!-- Top strip: what this build is, and where the whole thing lives. Also the
     one piece of chrome present on every page (film pages have no sidebar), so
     it carries the credit link to the ranking's source. -->
<div class="topstrip">
  <p class="ts-note">
    <span class="ts-pill">Demo</span>
    <span class="ts-text">
      <b>Limited functionality.</b>
      The parts of the app that depend on a private home server are inactive here — browsing, filtering, search and your own lists all work as normal.
    </span>
  </p>
  <div class="ts-links">
    <a class="ts-link" href={TSPDT_URL} target="_blank" rel="noopener"
       title="They Shoot Pictures, Don't They? — the critics' poll this catalogue ranks">
      <span class="ts-lk-label">Ranking by</span> TSPDT<Icon name="external" size={12} stroke={2} />
    </a>
    <a class="ts-link strong" href={github} target="_blank" rel="noopener"
       title="The complete application, including the parts that are inactive here">
      <Icon name="github" size={13} /> Full source
    </a>
  </div>
</div>
{/if}

{#if !onFilm}
<header class="mobilebar">
  <button class="mb-burger" onclick={() => (menuOpen = true)} aria-label="Open filters and menu" aria-expanded={menuOpen}>
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18"/></svg>
  </button>
  <a class="mb-home" href="/" aria-label="Home"><Icon name="film" size={18} /></a>
  <div class="mb-search search">
    <svg viewBox="0 0 24 24" class="search-ico" aria-hidden="true"><path d="M21 21l-4.3-4.3M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16z"/></svg>
    <input type="search" placeholder="Search title or director" value={q} oninput={onSearch}
           onfocus={() => (searchFocused = true)} onblur={() => (searchFocused = false)} autocomplete="off" />
  </div>
</header>
{/if}

<div class="app" class:full={onFilm} class:has-strip={demo}>
  {#if !onFilm}
  <div class="scrim" class:show={menuOpen} onclick={closeMenu} aria-hidden="true"></div>
  <aside class="sidebar" class:open={menuOpen}>
    <button class="drawer-close" onclick={closeMenu} aria-label="Close menu"><Icon name="x" size={16} /></button>
    <a class="brand" href="/">
      <span class="brand-mark"><Icon name="film" size={16} /></span><span class="brand-word">FILM&nbsp;INDEX</span>
    </a>

    <div class="search">
      <svg viewBox="0 0 24 24" class="search-ico" aria-hidden="true"><path d="M21 21l-4.3-4.3M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16z"/></svg>
      <input type="search" placeholder="Search title or director" value={q} oninput={onSearch}
             onfocus={() => (searchFocused = true)} onblur={() => (searchFocused = false)} autocomplete="off" />
    </div>

    <nav class="statuses">
      <button class="stat" class:on={!statusNow()} onclick={() => { navigate({ status: '' }); closeMenu(); }}>All films</button>
      <button class="stat" class:on={statusNow() === 'watchlist'} onclick={() => { navigate({ status: 'watchlist' }); closeMenu(); }}>
        Watchlist <span>{$countsStore.watchlist}</span>
      </button>
      <button class="stat" class:on={statusNow() === 'seen'} onclick={() => { navigate({ status: 'seen' }); closeMenu(); }}>
        Seen <span>{$countsStore.seen}</span>
      </button>
      <button class="stat minor" class:on={statusNow() === 'rewatch'} onclick={() => { navigate({ status: 'rewatch' }); closeMenu(); }}>
        Rewatch <span>{$countsStore.rewatch}</span>
      </button>
      <button class="stat minor" class:on={statusNow() === 'unfinished'} onclick={() => { navigate({ status: 'unfinished' }); closeMenu(); }}>
        Unfinished <span>{$countsStore.unfinished}</span>
      </button>
    </nav>

    {#if data.downloads && (data.downloads.downloaded || data.downloads.downloading || data.downloads.wanted || data.downloads.error)}
    <nav class="statuses dl">
      <button class="stat minor" class:on={radarrNow() === 'downloaded'} onclick={() => { navigate({ radarr: radarrNow() === 'downloaded' ? '' : 'downloaded' }); closeMenu(); }}>
        Downloaded <span>{data.downloads.downloaded}</span>
      </button>
      {#if data.downloads.downloading}
      <button class="stat minor" class:on={radarrNow() === 'downloading'} onclick={() => { navigate({ radarr: radarrNow() === 'downloading' ? '' : 'downloading' }); closeMenu(); }}>
        Downloading <span>{data.downloads.downloading}</span>
      </button>
      {/if}
      {#if data.downloads.wanted}
      <button class="stat minor" class:on={radarrNow() === 'wanted'} onclick={() => { navigate({ radarr: radarrNow() === 'wanted' ? '' : 'wanted' }); closeMenu(); }}>
        Wanted <span>{data.downloads.wanted}</span>
      </button>
      {/if}
      {#if data.downloads.error}
      <button class="stat minor" class:on={radarrNow() === 'error'} onclick={() => { navigate({ radarr: radarrNow() === 'error' ? '' : 'error' }); closeMenu(); }}>
        Issues <span>{data.downloads.error}</span>
      </button>
      {/if}
    </nav>
    {/if}

    <div class="filters">
      <div class="fhead">
        <span>Filters</span>
        {#if activeCount}<button class="clear" onclick={clearAll}>Clear ({activeCount})</button>{/if}
      </div>

      <section>
        <h4>Decade</h4>
        <div class="chips">
          {#each data.facets.decades as d}
            <button class="chip" class:on={isSel('decade', d.value)} onclick={() => toggle('decade', d.value)}>{d.value}s</button>
          {/each}
        </div>
      </section>

      <section>
        <h4>Colour</h4>
        <div class="chips">
          {#each data.facets.colours as c}
            <button class="chip" class:on={isSel('colour', c.value)} onclick={() => toggle('colour', c.value)}>{colourLabel(c.value)}</button>
          {/each}
        </div>
      </section>

      <section>
        <div class="fh"><h4>Genre</h4>{#if sel('genre').length}<button class="clear" onclick={() => navigate({ genre: '' })}>Reset</button>{/if}</div>
        <div class="checklist">
          {#each data.facets.genres as g}
            <label class="check" class:on={isSel('genre', g.value)}>
              <input type="checkbox" checked={isSel('genre', g.value)} onchange={() => toggle('genre', g.value)} />
              <span class="cl-name">{g.value}</span><span class="cl-count">{g.count.toLocaleString()}</span>
            </label>
          {/each}
        </div>
      </section>

      <section>
        <div class="fh"><h4>Country</h4>{#if sel('country').length}<button class="clear" onclick={() => navigate({ country: '' })}>Reset</button>{/if}</div>
        <input class="mini-search" placeholder="Filter countries" bind:value={countryQuery} />
        <div class="checklist">
          {#each countriesShown as c}
            <label class="check" class:on={isSel('country', c.value)}>
              <input type="checkbox" checked={isSel('country', c.value)} onchange={() => toggle('country', c.value)} />
              <span class="cl-name">{c.value}</span><span class="cl-count">{c.count.toLocaleString()}</span>
            </label>
          {/each}
        </div>
      </section>

      {#if data.facets.ages?.length}
      <section>
        <div class="fh"><h4>Age rating</h4>{#if ageLive < 18}<button class="clear" onclick={() => { ageLive = 18; navigate({ maxage: '' }); }}>Reset</button>{/if}</div>
        <input class="age-range" type="range" min="0" max="18" step="1" value={ageLive}
               oninput={onAgeInput} onchange={onAgeCommit} aria-label="Maximum age rating to show" />
        <div class="age-meta"><span>{ageLabel}</span>{#if ageLive < 18}<span class="age-n">{ageCount.toLocaleString()} rated</span>{/if}</div>
      </section>
      {/if}

      <section>
        <button class="new-toggle" class:on={isSel('new', '1')} onclick={() => navigate({ new: isSel('new', '1') ? '' : '1' })}>
          <Icon name="sparkles" size={14} /> New in {data.facets.latestEdition} edition
        </button>
      </section>
    </div>

    {#if hasDownloads}
      <a class="side-link" href="/downloads" onclick={closeMenu}>
        <span class="sl-ic"><Icon name="download" size={15} /></span> Download tracker{#if dl.downloading} · {dl.downloading} active{/if}
      </a>
    {/if}
    <a class="side-link" href="/letterboxd" onclick={closeMenu}>
      <span class="sl-ic"><Icon name="sync" size={15} /></span> Letterboxd import &amp; sync
    </a>

    <div class="side-foot">
      {#if userEmail}
        <div class="whoami" title={userEmail}>
          <svg viewBox="0 0 24 24" class="wa-ic" aria-hidden="true"><path d="M12 12a4 4 0 100-8 4 4 0 000 8zM4 20a8 8 0 0116 0"/></svg>
          <span>{userEmail}</span>
        </div>
      {/if}
      {#if demo}
        <!-- The desktop app only has something to play on the private instance,
             so the demo points at the code instead of an installer. -->
        <a class="theme" href={github} target="_blank" rel="noopener"
           title="Demo build — the complete application is on GitHub">
          <Icon name="github" size={15} /> Demo · source on GitHub
        </a>
      {:else if isTauri}
        {#if update?.available}
          <button class="theme app-upd" onclick={openRelease} title="A newer version is available — click to download"><Icon name="download" size={15} /> Update · v{update.latest}</button>
        {:else if update}
          <span class="theme static" title="Desktop app v{update.current}"><Icon name="monitor" size={15} /> App v{update.current}</span>
        {/if}
      {:else}
        <a class="theme" href="https://github.com/chrisJuresh/films/releases/latest" target="_blank" rel="noopener" title="Download the desktop app — opens films in mpv / your default player">
          <Icon name="monitor" size={15} /> Desktop app
        </a>
      {/if}
      <button class="theme" onclick={toggleTheme} title="Toggle theme">
        {#if themeName === 'light'}<Icon name="sun" size={15} /> Light{:else}<Icon name="moon" size={15} /> Dark{/if}
      </button>
    </div>
  </aside>
  {/if}

  <div class="content">
    {@render children()}
  </div>
</div>

<!-- Film pages hide the sidebar (and its update pill), so surface updates here too. -->
{#if onFilm && isTauri && update?.available}
  <button class="update-fab" onclick={openRelease} title="Download and install v{update.latest}">
    <Icon name="download" size={16} /> Update to v{update.latest}
  </button>
{/if}

<Toast />

<style>
  /* ---------------------------------------------- demo top strip --------- */
  /* Slim, full-width band above the whole shell: what this build is, and the
     two outbound credits (the ranking's source, and the real source code).
     Borrows the sidebar's vocabulary — surface fill, hairline border, accent
     pill — so it reads as chrome rather than as a browser notification. */
  .topstrip { --strip-h: 40px;
    display: flex; align-items: center; justify-content: space-between; gap: 18px;
    padding: 0 18px; min-height: var(--strip-h);
    background: color-mix(in srgb, var(--surface) 82%, transparent);
    backdrop-filter: blur(10px); border-bottom: 1px solid var(--border);
    font-size: 12.5px; color: var(--muted); }
  /* Sticky on desktop only — on a phone the vertical space is worth more than
     the reminder, so it scrolls away and the app bar keeps the top edge. */
  @media (min-width: 821px) {
    .topstrip { position: sticky; top: 0; z-index: 85; }
    /* Sidebar and the catalogue toolbar both pin to the top; move them below
       the strip so nothing hides underneath it. */
    :global(.app.has-strip .sidebar) { top: var(--strip-h, 40px); height: calc(100vh - var(--strip-h, 40px)); }
    :global(.app.has-strip .results-bar) { top: var(--strip-h, 40px); }
  }

  .ts-note { display: flex; align-items: center; gap: 10px; margin: 0; min-width: 0; }
  .ts-pill { flex: none; padding: 2.5px 8px; border-radius: 999px; background: var(--accent);
    color: var(--accent-ink); font-size: 10px; font-weight: 700; letter-spacing: .12em;
    text-transform: uppercase; }
  .ts-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ts-text b { color: var(--text); font-weight: 600; }

  .ts-links { flex: none; display: flex; align-items: center; gap: 8px; }
  .ts-link { display: inline-flex; align-items: center; gap: 6px; padding: 5px 11px;
    border-radius: 999px; border: 1px solid var(--border); background: var(--surface);
    color: var(--muted); text-decoration: none; font-size: 12px; white-space: nowrap;
    transition: color .12s, border-color .12s, background .12s; }
  .ts-link:hover { color: var(--text); border-color: var(--border-strong); }
  .ts-link .ts-lk-label { color: var(--faint); }
  .ts-link:hover .ts-lk-label { color: var(--muted); }
  .ts-link :global(.icon) { opacity: .75; }
  .ts-link:hover :global(.icon) { opacity: 1; }
  /* The source link is the one action worth taking from here. */
  .ts-link.strong { color: var(--text); font-weight: 600;
    border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); }
  .ts-link.strong:hover { border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 12%, var(--surface)); }
  .ts-link.strong :global(.icon) { opacity: 1; color: var(--accent); }

  @media (max-width: 980px) {
    /* Keep the sentence honest but short once it can't fit whole. */
    .ts-text { white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  }
  @media (max-width: 820px) {
    .topstrip { flex-wrap: wrap; gap: 8px 12px; padding: 9px 12px; font-size: 12px; }
    .ts-note { align-items: flex-start; }
    .ts-pill { margin-top: 1px; }
    .ts-links { width: 100%; }
    .ts-link { flex: 1; justify-content: center; padding: 8px 10px; }
  }

  /* Floating update prompt for film pages (the sidebar's pill isn't shown there). */
  .update-fab { position: fixed; left: 18px; bottom: 18px; z-index: 150; display: inline-flex;
    align-items: center; gap: 8px; padding: 11px 16px; border-radius: 999px; border: none; cursor: pointer;
    background: var(--accent); color: var(--accent-ink); font-weight: 600; font-size: 13.5px;
    box-shadow: 0 10px 30px rgba(0,0,0,.5); }
  .update-fab:hover { filter: brightness(1.07); }
  @media (max-width: 820px) { .update-fab { left: 12px; bottom: 12px; } }
</style>
