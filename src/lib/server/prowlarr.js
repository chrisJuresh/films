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
