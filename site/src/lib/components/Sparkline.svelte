<script>
  let { history = [] } = $props();

  const W = 640, H = 200, pad = { l: 48, r: 20, t: 22, b: 30 };
  let pts = $derived((history || []).filter((h) => h.position > 0));

  function fmt(n) {
    if (n < 1000) return String(n);
    const k = n / 1000;
    return (k < 10 ? k.toFixed(1).replace(/\.0$/, '') : Math.round(k)) + 'k';
  }

  function niceTicks(min, max) {
    if (min === max) return [min];
    const raw = new Set([min, max]);
    for (let e = 0; e <= 6; e++) { const v = 10 ** e; if (v > min && v < max) raw.add(v); }
    const sorted = [...raw].sort((a, b) => a - b);
    const minGap = (Math.log10(max) - Math.log10(min)) * 0.14;   // keep labels visually apart
    const kept = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      const v = sorted[i], isMax = i === sorted.length - 1;
      if (Math.log10(v) - Math.log10(kept[kept.length - 1]) >= minGap) kept.push(v);
      else if (isMax) kept[kept.length - 1] = v;                  // keep max; drop the too-close neighbour
    }
    const seen = new Set(), out = [];                             // no duplicate labels
    for (const v of kept) { const l = fmt(v); if (!seen.has(l)) { seen.add(l); out.push(v); } }
    return out;
  }

  function build(pts) {
    if (pts.length < 2) return null;
    const years = pts.map((p) => p.poll_year);
    const positions = pts.map((p) => p.position);
    const logs = positions.map((p) => Math.log10(p));
    const minY = Math.min(...years), maxY = Math.max(...years);
    const minP = Math.min(...positions), maxP = Math.max(...positions);
    const minL = Math.min(...logs), maxL = Math.max(...logs);
    const spanL = maxL - minL;
    const plotH = H - pad.t - pad.b;
    const x = (yr) => pad.l + (maxY === minY ? 0.5 : (yr - minY) / (maxY - minY)) * (W - pad.l - pad.r);
    // rank 1 (best) at top; higher rank number lower down
    const y = (lg) => spanL === 0 ? pad.t + plotH / 2 : pad.t + (lg - minL) / spanL * plotH;

    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.poll_year).toFixed(1)},${y(Math.log10(p.position)).toFixed(1)}`).join(' ');
    const area = `${line} L${x(maxY).toFixed(1)},${H - pad.b} L${x(minY).toFixed(1)},${H - pad.b} Z`;
    const dots = pts.map((p) => ({ cx: x(p.poll_year), cy: y(Math.log10(p.position)), yr: p.poll_year, pos: p.position }));
    const gridY = niceTicks(minP, maxP).map((v) => ({ v, gy: y(Math.log10(v)) }));
    const last = dots[dots.length - 1];
    const first = dots[0];
    const labelY = Math.min(Math.max(last.cy - 12, pad.t + 6), H - pad.b - 6);
    return { line, area, dots, gridY, minY, maxY, last, first, labelY };
  }
  let g = $derived(build(pts));
</script>

{#if g}
  <svg class="spark" viewBox="0 0 {W} {H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Ranking history">
    <defs>
      <linearGradient id="sg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="var(--accent)" stop-opacity=".24" />
        <stop offset="1" stop-color="var(--accent)" stop-opacity="0" />
      </linearGradient>
    </defs>

    <!-- y gridlines + rank labels -->
    {#each g.gridY as t}
      <line x1={pad.l} y1={t.gy} x2={W - pad.r} y2={t.gy} stroke="var(--border)" stroke-width="1" />
      <text x={pad.l - 8} y={t.gy + 3.5} text-anchor="end" font-size="10.5" fill="var(--faint)">#{fmt(t.v)}</text>
    {/each}
    <text x={6} y={pad.t - 8} font-size="9.5" fill="var(--faint)">rank</text>

    <!-- area + line -->
    <path d={g.area} fill="url(#sg)" />
    <path d={g.line} fill="none" stroke="var(--accent)" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round" />

    <!-- points -->
    {#each g.dots as d}
      <circle cx={d.cx} cy={d.cy} r="3" fill="var(--accent)"><title>{d.yr}: rank {d.pos}</title></circle>
    {/each}
    <!-- highlight latest edition -->
    <circle cx={g.last.cx} cy={g.last.cy} r="5" fill="var(--accent)" stroke="var(--bg)" stroke-width="2" />
    <text x={g.last.cx - 8} y={g.labelY} text-anchor="end" font-size="12" font-weight="700" fill="var(--text)">#{g.last.pos}</text>

    <!-- x year labels -->
    <text x={g.first.cx} y={H - 9} text-anchor="start" font-size="11" fill="var(--faint)">{g.minY}</text>
    <text x={g.last.cx} y={H - 9} text-anchor="end" font-size="11" fill="var(--faint)">{g.maxY}</text>
  </svg>
{:else}
  <p class="none">Not enough ranking history to chart.</p>
{/if}

<style>
  .spark { width: 100%; height: auto; display: block; max-width: 680px; }
  .none { color: var(--faint); font-size: 13px; }
</style>
