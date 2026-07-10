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

// country-agnostic letter/word codes -> minimum age (0 = all ages). null = no
// age information (unrated / noise). Hand-built from the real rating systems in
// the catalogue, biased to SAFETY: where a code is ambiguous across countries
// the fallback is the more restrictive value, with COUNTRY_MAP pinning the
// confident exceptions. Numeric codes ("12", "PG-13", "K-16"…) are not listed —
// certToAge extracts their number.
export const LETTER_MAP = {
  // MPAA-style / English
  G: 0, PG: 8, pg: 8, 'TV-PG': 8, GP: 8, R: 17, M: 15, E: 0,
  NR: null, UR: null, Unrated: null, Approved: null,
  // "all ages" words (many languages)
  ALL: 0, All: 0, 'All Ages': 0, general: 0, U: 0, UA: 12,
  TP: 0, T: 0, TE: 0, AL: 0, S: 0, AA: 0, V: 0, KN: 0, K: 0, 'Κ': 0,
  APTA: 0, APT: 0, ATP: 0, Atp: 0, Apt: 0, 'Públicos': 0, Ai: 0,
  L: 0, Livre: 0, livre: 0, 'e Livre': 0, SU: 0, 'Semua Umur': 0, Remaja: 13,
  Btl: 0, BTL: 0, 'Barntillåten': 0, Leyfð: 0, 'Tilladt for alle': 0, 't.f.a.': 0,
  'Genel İzleyici': 0, 'Genel İzleyici Kitlesi': 0,
  // Belgium
  KT: 0, EA: 0, 'KT/EA': 0, KNT: 16, 'KNT/ENA': 16,
  // Mexico/Bulgaria single letters (fallbacks; exceptions in COUNTRY_MAP)
  A: 0, B: 12, C: 18, D: 16, 'А': 0, c: 12,
  // Hong Kong (I / IIA / IIB / III)
  I: 0, II: 12, IIA: 12, 'Category II': 12, IIB: 16, 'II B': 16, III: 18, 'Cat III': 18,
  // Taiwan
  '普遍級': 0, '普通級': 0, '保護級': 6, '輔導級': 12, '限制級': 18,
  // Korea
  '전체관람가': 0, '청소년관람불가': 18, '청소년 관람불가': 18, '청소년 관람 불가': 18,
  // Israel (Hebrew "permitted for all ages"; last one = withdrawn/no cinema release)
  'הותר לכל': 0, 'הותר לכל הגילאים': 0, 'הותר לכול': 0, 'מותר לכל הגילאים': 0, 'ללא הפצה לבתי הקולנוע': null,
  // Thailand (general audiences)
  'ท': 0, 'ทั่วไป': 0, 'ท ทั่วไป': 0, 'เรท ท ทั่วไป': 0, 'เรท G': 0, P: 0,
  // Kazakhstan / Cyrillic
  'БА': 0, 'К': 12,
  // adult / restricted / banned
  X: 18, RC: 18, IC: 18,
  // Romania / Czech / misc
  AP: 12, AG: 0, MP: 0, 'G+': 6, SR: 0, F: 16,
  // no rating / scraping noise -> ignored
  '-': null, '?': null, 'N/A': null, NA: null, ni: null, r: null, OM: null, ZA: null,
  'first screening': null, imdb: null, Aerofilms: null, 'Vertical Entertainment': null,
  'Qatar Cinemas': null, 'Dubai International Film Festival': null,
  'Night Visions Film Festival': null, 'Festival Internacional de Cine de Viña del Mar': null,
};

// country-specific overrides (keyed "CC:CODE"), for codes whose meaning differs
// by system. Takes precedence over LETTER_MAP.
export const COUNTRY_MAP = {
  'IN:A': 18,   // India: A = adults only  (elsewhere A = all ages)
  'BG:B': 0,    // Bulgaria: B = no age restriction  (Mexico B = 12)
  'BG:C': 12,   // Bulgaria: C = 12+  (Mexico C = 18)
  'MX:D': 18,   // Mexico: D = adults only  (Bulgaria D = 16)
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
