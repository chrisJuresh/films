import { counts, getFacets } from '$lib/server/db.js';
import { metaProviders } from '$lib/server/meta.js';

export function load({ locals }) {
  return { counts: counts(locals.user), meta: metaProviders(), facets: getFacets() };
}
