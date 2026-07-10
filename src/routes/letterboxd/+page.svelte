<script>
  import { invalidateAll } from '$app/navigation';
  import { displayTitle } from '$lib/util.js';
  import { counts as countsStore, toast } from '$lib/stores.js';

  let { data } = $props();
  let busy = $state(false);
  let result = $state(null);
  let fileInput;

  async function upload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    busy = true; result = null;
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await fetch('/api/letterboxd', { method: 'POST', body: fd });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.message || 'Import failed.');
      result = d;
      if (d.counts) countsStore.set(d.counts);
      toast(`Imported ${d.added} newly watched film${d.added === 1 ? '' : 's'}.`, 'ok');
      await invalidateAll();
    } catch (err) {
      toast(err.message || 'Could not import that file.', 'error', 4600);
    } finally {
      busy = false;
      if (fileInput) fileInput.value = '';
    }
  }
</script>

<svelte:head><title>Letterboxd · Film Index</title></svelte:head>

<div class="wrap">
  <a class="back" href="/">← Catalogue</a>
  <h1>Letterboxd</h1>
  <p class="lede">
    Import your Letterboxd <code>watched.csv</code> — or drop the whole export
    <code>.zip</code> and it'll pull <code>watched.csv</code> out. It only ever
    <strong>adds</strong> watched films; it never un-marks anything.
  </p>

  <label class="drop" class:busy>
    <input type="file" accept=".zip,.csv,text/csv,application/zip" onchange={upload} bind:this={fileInput} disabled={busy} />
    <span class="drop-ic">{busy ? '⏳' : '⬆'}</span>
    <span class="drop-t">{busy ? 'Importing…' : 'Choose your export .zip or watched.csv'}</span>
  </label>

  {#if result}
    <div class="summary">
      <div><b>{result.added}</b> newly watched</div>
      <div><b>{result.already}</b> already tracked</div>
      <div><b>{result.matched}</b> matched</div>
      <div><b>{result.unmatched.length}</b> not in catalogue</div>
    </div>
    {#if result.unmatched.length}
      <details class="unmatched">
        <summary>{result.unmatched.length} titles didn't match (not in TSPDT, or a title/year difference)</summary>
        <ul>{#each result.unmatched as u}<li>{u.name} <span>({u.year || '—'})</span></li>{/each}</ul>
      </details>
    {/if}
  {/if}

  <section class="block">
    <h2>Watched here, not in Letterboxd <span class="n">{data.onlySite.length}</span></h2>
    <p class="sub">Ticked “seen” on this site but absent from your Letterboxd watched list — candidates to log there.</p>
    {#if data.onlySite.length}
      <ul class="films">
        {#each data.onlySite as f (f.id_tspdt)}
          <li><a href="/film/{f.id_tspdt}"><span class="rk">#{f.rank}</span><span class="ti">{displayTitle(f.title)}</span><span class="yr">{f.year}</span></a></li>
        {/each}
      </ul>
    {:else}<p class="empty">Nothing here — your site “seen” list is all in Letterboxd.</p>{/if}
  </section>

  <section class="block">
    <h2>From Letterboxd, un-ticked here <span class="n">{data.lbRemoved.length}</span></h2>
    <p class="sub">Imported from Letterboxd, then later un-ticked on the site. The record is kept.</p>
    {#if data.lbRemoved.length}
      <ul class="films">
        {#each data.lbRemoved as f (f.id_tspdt)}
          <li><a href="/film/{f.id_tspdt}"><span class="rk">#{f.rank}</span><span class="ti">{displayTitle(f.title)}</span><span class="yr">{f.year}</span></a></li>
        {/each}
      </ul>
    {:else}<p class="empty">Nothing here.</p>{/if}
  </section>
</div>

<style>
  .wrap { max-width: 860px; margin: 0 auto; padding: 26px 30px 70px; }
  .back { display: inline-block; color: var(--muted); text-decoration: none; font-size: 13.5px; margin-bottom: 18px; }
  .back:hover { color: var(--text); }
  h1 { font-family: var(--font-display); font-weight: 700; font-size: clamp(28px, 4vw, 40px); margin: 0 0 8px; letter-spacing: -.02em; }
  .lede { color: var(--muted); font-size: 15px; line-height: 1.55; max-width: 68ch; margin: 0 0 22px; }
  code { background: var(--surface-2); border: 1px solid var(--border); border-radius: 6px; padding: 1px 6px; font-size: 13px; }

  .drop { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px;
    padding: 30px; border: 1.5px dashed var(--border-strong); border-radius: 16px; background: var(--surface);
    cursor: pointer; text-align: center; color: var(--muted); transition: border-color .15s, background .15s; }
  .drop:hover { border-color: var(--accent); color: var(--text); }
  .drop.busy { cursor: progress; opacity: .7; }
  .drop input { display: none; }
  .drop-ic { font-size: 26px; }
  .drop-t { font-size: 14.5px; font-weight: 600; }

  .summary { display: flex; flex-wrap: wrap; gap: 10px 22px; margin-top: 20px; padding: 16px 18px;
    border: 1px solid var(--border); border-radius: 12px; background: var(--surface-2); font-size: 14px; color: var(--muted); }
  .summary b { color: var(--text); font-variant-numeric: tabular-nums; font-size: 17px; margin-right: 4px; }
  .unmatched { margin-top: 12px; font-size: 13.5px; color: var(--muted); }
  .unmatched summary { cursor: pointer; }
  .unmatched ul { margin: 8px 0 0; padding-left: 18px; columns: 2; }
  .unmatched li span { color: var(--faint); }

  .block { margin-top: 38px; border-top: 1px solid var(--border); padding-top: 22px; }
  h2 { font-size: 16px; font-weight: 600; margin: 0 0 4px; display: flex; align-items: center; gap: 10px; }
  h2 .n { font-size: 12px; font-weight: 700; color: var(--accent); background: var(--surface-2);
    border: 1px solid var(--border); border-radius: 999px; padding: 1px 9px; font-variant-numeric: tabular-nums; }
  .sub { color: var(--faint); font-size: 13px; margin: 0 0 14px; }
  .empty { color: var(--faint); font-size: 13.5px; }
  .films { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 1px; }
  .films a { display: flex; align-items: center; gap: 12px; padding: 9px 10px; border-radius: 8px;
    text-decoration: none; color: var(--text); font-size: 14px; }
  .films a:hover { background: var(--surface); }
  .rk { color: var(--accent); font-size: 12px; font-weight: 700; font-variant-numeric: tabular-nums; flex: none; width: 52px; }
  .ti { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .yr { color: var(--faint); font-size: 12px; flex: none; }

  @media (max-width: 820px) {
    .wrap { padding: 18px 16px 56px; }
    .unmatched ul { columns: 1; }
  }
</style>
