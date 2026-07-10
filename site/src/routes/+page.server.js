import { queryFilms, getFacets } from '$lib/server/db.js';

export function load({ url, locals }) {
  const p = Object.fromEntries(url.searchParams);
  const { total, items } = queryFilms({ ...p, user: locals.user, limit: 60, offset: 0 });
  return { films: items, total, facets: getFacets(), filters: p };
}
