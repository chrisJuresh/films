import { counts, getFacets, downloadCounts } from '$lib/server/db.js';
import { metaProviders } from '$lib/server/meta.js';
import { refreshDownloadState } from '$lib/server/radarr.js';
import { GITHUB_URL } from '$lib/server/demo.js';

export function load({ locals }) {
  const demo = !!locals.demo;
  // Radarr only exists on the home server, and the demo has no download UI to
  // feed — so skip the poll entirely rather than letting it fail quietly.
  if (!demo) refreshDownloadState();
  return {
    counts: counts(locals.user),
    meta: metaProviders(),
    facets: getFacets(),
    // The demo identity is an opaque cookie id, not a person — nothing to show.
    user: demo ? null : locals.user,
    // Omitted outright in the demo (not nulled): the key itself would otherwise
    // sit in the serialised page payload describing a library that isn't here.
    ...(demo ? {} : { downloads: downloadCounts() }),
    demo,
    github: GITHUB_URL
  };
}
