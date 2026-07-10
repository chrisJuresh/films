// Map raw film certifications (all countries) onto a single "minimum admittance
// age" axis, so the catalogue can be filtered by one age slider.
//
// Design / safety:
//   * A film's age = the MOST RESTRICTIVE (highest) age across all its country
//     ratings. If any reputable system rates it adults-only, it's treated as 18,
//     so an unsuitable film is never surfaced to a younger age.
//   * Numeric codes carry their own age ("12", "PG-13"->13, "K-16"->16,
//     "MA 15+"->15, "R18+"->18). We extract the number.
//   * Letter/word codes vary by country ("A" = all-ages in Denmark, adults-only
//     in India), so they're resolved via COUNTRY_MAP (country-specific) then
//     LETTER_MAP (country-agnostic fallback). Values are vetted (see
//     classify-age-certs workflow); noise / "not rated" strings map to null.
//   * Anything with no age information -> null (ignored in the aggregate; a film
//     with only null certs is "unrated" and only appears with the slider off).
//
// Pure ESM, zero dependencies — imported by both the SvelteKit server and the
// standalone sync/backfill_certs.mjs script.

export const MAX_AGE = 18;

// country-agnostic letter/word codes -> age (0 = all ages). null = no age info.
// Generated + adversarially verified by the classify-age-certs workflow.
export const LETTER_MAP = {
  /* __LETTER_MAP__ */
};

// country-specific overrides for codes whose meaning differs by system, keyed
// "CC:CODE". Takes precedence over LETTER_MAP.
export const COUNTRY_MAP = {
  /* __COUNTRY_MAP__ */
};

/** Minimum admittance age for a single certification, or null if it carries no
 *  age information. `country` is the 2-letter code the rating came from. */
export function certToAge(rawCert, country) {
  if (rawCert == null) return null;
  const cert = String(rawCert).trim();
  if (!cert) return null;
  const cc = String(country || '').toUpperCase();

  const override = COUNTRY_MAP[cc + ':' + cert];
  if (override !== undefined) return override;                     // may be null (noise)
  if (Object.prototype.hasOwnProperty.call(LETTER_MAP, cert)) return LETTER_MAP[cert];

  const m = cert.match(/\d{1,2}/);                                 // "12", "PG-13", "MA 15+", "R18+"…
  if (m) { const n = +m[0]; return n > MAX_AGE ? MAX_AGE : n; }

  return null;                                                     // unknown, non-numeric
}

/** A film's effective minimum age from its certifications (rows of {country,
 *  cert}). The MAX across parseable certs (most restrictive wins); null if none
 *  carry age info. */
export function filmMinAge(certRows) {
  let max = null;
  for (const r of certRows || []) {
    const a = certToAge(r.cert, r.country);
    if (a == null) continue;
    if (max == null || a > max) max = a;
  }
  return max;
}
