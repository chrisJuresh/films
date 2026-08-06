<script>
  // Small, consistent inline-SVG icon set (thin-stroke, currentColor) so buttons
  // look professional instead of relying on OS emoji/unicode glyphs.
  let { name, size = 18, stroke = 1.9, fill = 'none', spin = false } = $props();
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
    // Brand mark — Phosphor "film-strip" (MIT), drawn on a 256 grid so it is
    // scaled down onto this set's 24 grid. Solid, so it ignores `stroke`.
    film:      '<g transform="scale(.09375)" fill="currentColor" stroke="none"><path d="M216,40H40A16,16,0,0,0,24,56V200a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A16,16,0,0,0,216,40ZM40,88h80v80H40Zm96-16V56h32V72Zm-16,0H88V56h32Zm0,112v16H88V184Zm16,0h32v16H136Zm0-16V88h80v80Zm80-96H184V56h32ZM72,56V72H40V56ZM40,184H72v16H40Zm176,16H184V184h32v16Z"/></g>',
    sync:      '<path d="M20 11a8 8 0 0 0-14-4.5L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14 4.5L20 16"/><path d="M20 20v-4h-4"/>',
    x:         '<path d="M6 6l12 12M18 6 6 18"/>',
    search:    '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
    menu:      '<path d="M3 6h18M3 12h18M3 18h18"/>',
    user:      '<circle cx="12" cy="8" r="4"/><path d="M4 20a8 8 0 0 1 16 0"/>',
    star:      '<path d="M12 3.5l2.6 5.7 6.1.6-4.6 4 1.4 6-5.5-3.2L6 19.8l1.4-6-4.6-4 6.1-.6z" fill="currentColor" stroke="none"/>',
    alert:     '<path d="M10.3 4 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 4a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    up:        '<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>',
    chevron:   '<path d="m6 9 6 6 6-6"/>',
    hdd:       '<rect x="3" y="7.5" width="18" height="9" rx="2"/><path d="M7 12h5.5"/><path d="M16.5 12h.01"/>',
    monitor:   '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8"/><path d="M12 16v4"/>',
    torrent:   '<circle cx="12" cy="12" r="9"/><path d="M12 7v6l4 2"/>',
    magnet:    '<path d="M6 4v7a6 6 0 0 0 12 0V4"/><path d="M6 4H2.5M18 4h3.5M6 8H2.5M18 8h3.5"/>',
    folder:    '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    plus:      '<path d="M12 5v14M5 12h14"/>',
    lock:      '<rect x="4.5" y="10.5" width="15" height="9.5" rx="2.2"/><path d="M8 10.5v-3a4 4 0 0 1 8 0v3"/>',
    // GitHub's Octicons mark (MIT), drawn on a 16 grid and scaled onto this
    // set's 24. Solid, so it ignores `stroke`.
    github:    '<g transform="scale(1.5)" fill="currentColor" stroke="none"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.1-.25-.36-1.07.08-2.22 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.15.18 1.97.08 2.22.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A7.995 7.995 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></g>',
    // "Where to watch" — a ticket stub, deliberately not the play triangle: this
    // sends you to a service, it doesn't start a stream.
    ticket:    '<path d="M3 8.5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2 2 2 0 0 0 0 7 2 2 0 0 1-2 2H5a2 2 0 0 1-2-2 2 2 0 0 0 0-7z"/><path d="M14.5 6.5v11" stroke-dasharray="2 2.4"/>',
    external:  '<path d="M14 4h6v6"/><path d="M20 4l-8.5 8.5"/><path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>',
  };
</script>

<svg class="icon" class:spin width={size} height={size} viewBox="0 0 24 24" {fill} stroke="currentColor"
     stroke-width={stroke} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
>{@html ICONS[name] || ''}</svg>

<style>
  .icon { display: inline-block; vertical-align: middle; flex: none; }
  .icon.spin { animation: icon-spin 0.8s linear infinite; transform-origin: 50% 50%; }
  @keyframes icon-spin { to { transform: rotate(360deg); } }
</style>
