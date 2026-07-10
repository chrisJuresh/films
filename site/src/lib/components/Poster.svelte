<script>
  import { gradientFor, displayTitle } from '$lib/util.js';
  let { title, rank = null, src = null, big = false } = $props();
  let ok = $state(true);
  // reset the error flag whenever the source changes
  $effect(() => { src; ok = true; });
</script>

<div class="poster" class:big style={src && ok ? undefined : `background:${gradientFor(title)}`}>
  {#if src && ok}
    <img src={src} alt={displayTitle(title)} loading="lazy" onerror={() => (ok = false)} />
  {:else}
    <div class="grain"></div>
    {#if rank}<span class="wm">{rank}</span>{/if}
    <div class="ptitle">{displayTitle(title)}</div>
  {/if}
</div>

<style>
  .poster {
    position: relative; aspect-ratio: 2/3; width: 100%; border-radius: 12px;
    overflow: hidden; display: flex; box-shadow: var(--shadow);
    background-color: var(--surface-2); background-size: cover; background-position: center;
  }
  /* subtle inset hairline instead of a real border -> no sub-pixel seam over the image */
  .poster::after { content: ''; position: absolute; inset: 0; border-radius: inherit;
    box-shadow: inset 0 0 0 1px var(--border); pointer-events: none; }
  .poster img { position: absolute; inset: 0; width: 100%; height: 100%;
    object-fit: cover; object-position: center; display: block; }
  .grain { position: absolute; inset: 0; pointer-events: none; opacity: .5;
    background-image: radial-gradient(rgba(255,255,255,.05) 1px, transparent 1px);
    background-size: 3px 3px; }
  .wm { position: absolute; right: 8px; bottom: -6px; font-family: var(--font-display);
    font-weight: 700; font-size: 74px; line-height: 1; color: rgba(255,255,255,.10);
    letter-spacing: -.05em; }
  .ptitle { position: relative; margin: auto 14px; text-align: center;
    font-family: var(--font-display); font-weight: 600; font-size: 17px; line-height: 1.22;
    color: #f4efe4; text-shadow: 0 2px 14px rgba(0,0,0,.6);
    display: -webkit-box; -webkit-line-clamp: 5; -webkit-box-orient: vertical; overflow: hidden; }
  .big .ptitle { font-size: 22px; }
  .big .wm { font-size: 104px; }
</style>
