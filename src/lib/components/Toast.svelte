<script>
  import { toasts } from '$lib/stores.js';
  import { fly } from 'svelte/transition';
</script>

<div class="toast-wrap" aria-live="polite">
  {#each $toasts as t (t.id)}
    <div class="toast {t.type}" transition:fly={{ y: 16, duration: 220 }}>
      <span class="ic">{t.type === 'error' ? '⚠' : t.type === 'ok' ? '✓' : 'ℹ'}</span>
      <span>{t.message}</span>
    </div>
  {/each}
</div>

<style>
  .toast-wrap { position: fixed; right: 18px; bottom: 18px; z-index: 200; display: flex;
    flex-direction: column; gap: 10px; max-width: min(380px, 90vw); }
  .toast { display: flex; align-items: center; gap: 10px; padding: 12px 15px;
    background: var(--surface-2); color: var(--text); border: 1px solid var(--border-strong);
    border-radius: 12px; box-shadow: var(--shadow); font-size: 13.5px; }
  .toast .ic { display: grid; place-items: center; width: 20px; height: 20px; border-radius: 999px;
    font-size: 12px; flex: none; }
  .toast.error { border-color: color-mix(in srgb, #e5484d 55%, var(--border-strong)); }
  .toast.error .ic { background: #e5484d; color: #fff; }
  .toast.ok .ic { background: var(--free); color: #06210b; }
  .toast.info .ic { background: var(--accent); color: var(--accent-ink); }
</style>
