import { counts, getFacets } from '$lib/server/db.js';
import { metaProviders } from '$lib/server/meta.js';

export function load() {
  return { counts: counts(), meta: metaProviders(), facets: getFacets() };
}
