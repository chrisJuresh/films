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
