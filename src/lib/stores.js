import { writable } from 'svelte/store';

/* toast notifications */
export const toasts = writable([]);
let _id = 0;
export function toast(message, type = 'info', ttl = 3400) {
  const t = { id: ++_id, message, type };
  toasts.update((a) => [...a, t]);
  setTimeout(() => toasts.update((a) => a.filter((x) => x.id !== t.id)), ttl);
}

/* header counts, updated after status changes */
export const counts = writable({ watchlist: 0, seen: 0, rewatch: 0, unfinished: 0 });

/* theme */
export const theme = writable('dark');

/* Desktop app: "Save to PC" downloads run in the app backend and keep going
   across navigation, so their progress is tracked HERE (not on the film-page
   component) keyed by film id: { [id]: { pct, done, error } }. */
export const downloads = writable({});
let _dlListening = false;
export async function initDownloadTracker() {
  const t = typeof window !== 'undefined' ? window.__TAURI__ : null;
  if (_dlListening || !t?.event?.listen) return;
  _dlListening = true;
  await t.event.listen('films-download-progress', (e) => {
    const d = e.payload;
    if (!d || d.id == null) return;
    const pct = d.total ? Math.round((d.received / d.total) * 100) : 0;
    downloads.update((m) => ({ ...m, [d.id]: { pct, done: !!d.done, error: d.error || null } }));
  });
}
export function markDownloadStarted(id) {
  downloads.update((m) => ({ ...m, [id]: { pct: 0, done: false, error: null } }));
}

/* Desktop app: mpv reports the position it stopped at (via a `mpv-progress`
   event when it quits) so the site's "watched %" updates for mpv sessions too —
   the browser player can't see into an external mpv. Posts to the playback API. */
let _mpvListening = false;
export async function initMpvProgress() {
  const t = typeof window !== 'undefined' ? window.__TAURI__ : null;
  if (_mpvListening || !t?.event?.listen) return;
  _mpvListening = true;
  await t.event.listen('mpv-progress', async (e) => {
    const d = e.payload;
    if (!d || d.id == null || !(d.position > 0)) return;
    try {
      await fetch(`/api/playback/${d.id}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ position: d.position })
      });
    } catch { /* best-effort */ }
  });
}
