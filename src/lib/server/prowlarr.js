import { env } from '$env/dynamic/private';
import { prowlarrSearch, ProwlarrError } from './prowlarrClient.js';

export { ProwlarrError };

// Prowlarr is optional. Without PROWLARR_API_KEY set, config() returns null and
// the fallback search is simply skipped — Radarr-only behaviour is unchanged.
function config() {
  const rawUrl = env.PROWLARR_URL?.trim();
  const apiKey = env.PROWLARR_API_KEY?.trim();
  if (!rawUrl || !apiKey) return null;
  let baseUrl;
  try { baseUrl = new URL(rawUrl.replace(/\/+$/, '') + '/'); } catch { return null; }
  if (!['http:', 'https:'].includes(baseUrl.protocol)) return null;
  return { baseUrl, apiKey };
}

export function prowlarrEnabled() {
  return !!config();
}

export async function searchProwlarr(query, year) {
  const cfg = config();
  if (!cfg) return [];
  return prowlarrSearch(cfg, query, year);
}

// If a search found nothing, distinguish "genuinely nothing" from "the indexer is
// temporarily disabled" (Prowlarr auto-disables an indexer after failures). Returns
// a human message when an indexer is down, else null.
export async function prowlarrDownNote() {
  const cfg = config();
  if (!cfg) return null;
  const get = (p) => fetch(new URL(p, cfg.baseUrl), { headers: { 'X-Api-Key': cfg.apiKey } }).then((r) => r.json()).catch(() => null);
  try {
    const [statuses, indexers] = await Promise.all([get('api/v1/indexerstatus'), get('api/v1/indexer')]);
    if (!Array.isArray(statuses)) return null;
    const names = new Map((Array.isArray(indexers) ? indexers : []).map((i) => [i.id, i.name]));
    const now = Date.now();
    const down = statuses
      .filter((s) => s.disabledTill && Date.parse(s.disabledTill) > now)
      .map((s) => ({ name: names.get(s.indexerId) || `indexer ${s.indexerId}`, till: s.disabledTill }));
    if (!down.length) return null;
    const till = new Date(Math.min(...down.map((d) => Date.parse(d.till))));
    const hhmm = `${String(till.getHours()).padStart(2, '0')}:${String(till.getMinutes()).padStart(2, '0')}`;
    return `${down.map((d) => d.name).join(', ')} ${down.length > 1 ? 'are' : 'is'} temporarily down (Prowlarr will retry around ${hhmm}). Try again shortly.`;
  } catch { return null; }
}
