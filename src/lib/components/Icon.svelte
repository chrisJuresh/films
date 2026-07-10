<script>
  // Small, consistent inline-SVG icon set (thin-stroke, currentColor) so buttons
  // look professional instead of relying on OS emoji/unicode glyphs.
  let { name, size = 18, stroke = 1.9, fill = 'none' } = $props();
  const ICONS = {
    play:      '<path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none"/>',
    download:  '<path d="M12 3v11.5"/><path d="m7.5 10 4.5 4.5 4.5-4.5"/><path d="M5 20h14"/>',
    video:     '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M10.5 9.2v5.6l4.6-2.8z" fill="currentColor" stroke="none"/>',
    heart:     '<path d="M12 20.5 4.4 12.9a4.7 4.7 0 0 1 6.6-6.6l1 1 1-1a4.7 4.7 0 0 1 6.6 6.6z"/>',
    check:     '<path d="M20 6 9 17l-5-5"/>',
    rotate:    '<path d="M20.5 12a8.5 8.5 0 1 1-2.4-5.9"/><path d="M20.5 3.5v4h-4"/>',
    hourglass: '<path d="M6 3h12"/><path d="M6 21h12"/><path d="M8 3c0 4.5 8 5 8 9s-8 4.5-8 9"/><path d="M16 3c0 4.5-8 5-8 9s8 4.5 8 9"/>',
    sun:       '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon:      '<path d="M20 14.5A8 8 0 1 1 9.5 4 6.3 6.3 0 0 0 20 14.5z"/>',
    sparkles:  '<path d="M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7z" fill="currentColor" stroke="none"/>',
    diamond:   '<path d="M12 2.5 21.5 12 12 21.5 2.5 12z"/>',
    sync:      '<path d="M20 11a8 8 0 0 0-14-4.5L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14 4.5L20 16"/><path d="M20 20v-4h-4"/>',
    x:         '<path d="M6 6l12 12M18 6 6 18"/>',
    search:    '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
    menu:      '<path d="M3 6h18M3 12h18M3 18h18"/>',
    user:      '<circle cx="12" cy="8" r="4"/><path d="M4 20a8 8 0 0 1 16 0"/>',
    star:      '<path d="M12 3.5l2.6 5.7 6.1.6-4.6 4 1.4 6-5.5-3.2L6 19.8l1.4-6-4.6-4 6.1-.6z" fill="currentColor" stroke="none"/>',
  };
</script>

<svg class="icon" width={size} height={size} viewBox="0 0 24 24" {fill} stroke="currentColor"
     stroke-width={stroke} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
>{@html ICONS[name] || ''}</svg>

<style>
  .icon { display: inline-block; vertical-align: middle; flex: none; }
</style>
