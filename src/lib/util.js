// Client-safe helpers (no DB / node imports).

const ARTICLES = new Set(['the', 'a', 'an', 'le', 'la', 'les', 'los', 'las', 'il', 'lo',
  'der', 'die', 'das', 'ein', 'eine', 'de', 'het', 'een', "l'"]);

/** "Rules of the Game, The" -> "The Rules of the Game" (display only). */
export function displayTitle(title) {
  const m = String(title || '').match(/^(.*),\s*([\p{L}']+)$/u);
  if (m && ARTICLES.has(m[2].toLowerCase())) {
    const art = m[2];
    return art.endsWith("'") ? art + m[1] : `${art} ${m[1]}`;
  }
  return title || '';
}

/** Deterministic, pleasant gradient for a typographic poster. */
export function gradientFor(title) {
  let h = 0;
  const s = String(title || 'film');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return `linear-gradient(155deg, hsl(${h} 32% 24%), hsl(${(h + 46) % 360} 40% 11%))`;
}

export function colourLabel(c) {
  return c === 'BW' ? 'Black & White' : c === 'Col' ? 'Colour' : c === 'Col-BW' ? 'Colour / B&W' : c;
}

/** Legal "where to watch" search deep-links. */
export function watchLinks(film) {
  const t = encodeURIComponent(displayTitle(film.title));
  const links = [
    { name: 'JustWatch', url: `https://www.justwatch.com/us/search?q=${t}`, free: false },
    { name: 'Criterion', url: `https://www.criterionchannel.com/search?q=${t}`, free: false },
    { name: 'MUBI', url: `https://mubi.com/en/search/films?query=${t}`, free: false },
    { name: 'Kanopy · library', url: `https://www.kanopy.com/en/search?query=${t}`, free: true },
    { name: 'Internet Archive', url: `https://archive.org/search?query=${t}`, free: true },
    { name: 'Letterboxd', url: `https://letterboxd.com/search/${t}/`, free: false }
  ];
  if (film.imdb_url) links.push({ name: 'IMDb', url: film.imdb_url, free: false });
  return links;
}
