import { counts, getFacets, downloadCounts } from '$lib/server/db.js';
import { metaProviders } from '$lib/server/meta.js';
import { refreshDownloadState } from '$lib/server/radarr.js';

export function load({ locals }) {
  refreshDownloadState();   // fire-and-forget, TTL-guarded, graceful
  return {
    counts: counts(locals.user),
    meta: metaProviders(),
    facets: getFacets(),
    user: locals.user,
    downloads: downloadCounts()
  };
}
