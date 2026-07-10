<script>
  import '../app.css';
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { counts as countsStore, theme } from '$lib/stores.js';
  import { colourLabel } from '$lib/util.js';
  import Toast from '$lib/components/Toast.svelte';

  let { data, children } = $props();

  // Film detail pages are full-bleed — no sidebar.
  let onFilm = $derived($page.url.pathname.startsWith('/film/'));

  $effect(() => { if (data?.counts) countsStore.set(data.counts); });

  let q = $state('');
  let countryQuery = $state('');
  let themeName = $state('dark');
  let searchFocused = $state(false);
  let menuOpen = $state(false);          // mobile filter drawer

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
    return () => mq.removeEventListener('change', onWide);
  });

  const sel = (key) => ($page.url.searchParams.get(key) || '').split(',').filter(Boolean);
  const isSel = (key, val) => sel(key).includes(String(val));
  const statusNow = () => $page.url.searchParams.get('status') || '';

  function navigate(patch) {
    const p = new URLSearchParams($page.url.searchParams);
    for (const [k, v] of Object.entries(patch)) {
      const val = Array.isArray(v) ? v.join(',') : v;
      if (!val) p.delete(k); else p.set(k, val);
    }
    p.delete('offset');
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
    ['q', 'decade', 'genre', 'country', 'colour', 'cert', 'new'].reduce(
      (n, k) => n + (($page.url.searchParams.get(k) || '') ? 1 : 0), 0)
  );
  function clearAll() { navigate({ q: '', decade: '', genre: '', country: '', colour: '', cert: '', new: '' }); }

  let userEmail = $derived(data?.user || null);

  function toggleTheme() {
    themeName = themeName === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = themeName;
    localStorage.setItem('tspdt-theme', themeName);
  }

  let countriesShown = $derived(
    (data.facets?.countries || []).filter((c) => c.value.toLowerCase().includes(countryQuery.toLowerCase()))
  );
</script>

{#if !onFilm}
<header class="mobilebar">
  <button class="mb-burger" onclick={() => (menuOpen = true)} aria-label="Open filters and menu" aria-expanded={menuOpen}>
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18"/></svg>
  </button>
  <a class="mb-home" href="/" aria-label="Home">◆</a>
  <div class="mb-search search">
    <svg viewBox="0 0 24 24" class="search-ico" aria-hidden="true"><path d="M21 21l-4.3-4.3M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16z"/></svg>
    <input type="search" placeholder="Search title or director" value={q} oninput={onSearch}
           onfocus={() => (searchFocused = true)} onblur={() => (searchFocused = false)} autocomplete="off" />
  </div>
</header>
{/if}

<div class="app" class:full={onFilm}>
  {#if !onFilm}
  <div class="scrim" class:show={menuOpen} onclick={closeMenu} aria-hidden="true"></div>
  <aside class="sidebar" class:open={menuOpen}>
    <button class="drawer-close" onclick={closeMenu} aria-label="Close menu">✕</button>
    <a class="brand" href="/">
      <span class="brand-mark">◆</span><span class="brand-word">FILM&nbsp;INDEX</span>
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
    </nav>

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
        <h4>Genre</h4>
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
        <h4>Country</h4>
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

      {#if data.facets.certifications?.length}
      <section>
        <h4>Age rating</h4>
        <div class="chips">
          {#each data.facets.certifications as c}
            <button class="chip" class:on={isSel('cert', c.value)} onclick={() => toggle('cert', c.value)} title="{c.count.toLocaleString()} films">{c.value}</button>
          {/each}
        </div>
      </section>
      {/if}

      <section>
        <button class="new-toggle" class:on={isSel('new', '1')} onclick={() => navigate({ new: isSel('new', '1') ? '' : '1' })}>
          ✦ New in {data.facets.latestEdition} edition
        </button>
      </section>
    </div>

    <a class="side-link" href="/letterboxd" onclick={closeMenu}>
      <span class="sl-ic">⬍</span> Letterboxd import &amp; sync
    </a>

    <div class="side-foot">
      {#if userEmail}
        <div class="whoami" title={userEmail}>
          <svg viewBox="0 0 24 24" class="wa-ic" aria-hidden="true"><path d="M12 12a4 4 0 100-8 4 4 0 000 8zM4 20a8 8 0 0116 0"/></svg>
          <span>{userEmail}</span>
        </div>
      {/if}
      <button class="theme" onclick={toggleTheme} title="Toggle theme">
        {themeName === 'light' ? '☀ Light' : '☾ Dark'}
      </button>
    </div>
  </aside>
  {/if}

  <div class="content">
    {@render children()}
  </div>
</div>

<Toast />
