import { queryFilms, getFacets } from '$lib/server/db.js';

export function load({ url }) {
  const p = Object.fromEntries(url.searchParams);
  const { total, items } = queryFilms({ ...p, limit: 60, offset: 0 });
  return { films: items, total, facets: getFacets(), filters: p };
}
