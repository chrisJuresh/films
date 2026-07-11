import { error } from '@sveltejs/kit';
import { exportTorrentFor } from '$lib/server/radarr.js';

// Download the .torrent for one of the film's server-side torrents (qBittorrent),
// named after the full torrent. `hash` identifies which one.
export async function GET({ url }) {
  const hash = url.searchParams.get('hash');
  if (!hash) throw error(400, 'A torrent hash is required.');
  const t = await exportTorrentFor(hash);
  if (!t?.bytes) throw error(404, 'That torrent is no longer on the server.');
  const fname = (t.name || hash).replace(/[/\\"\n\r]/g, '').slice(0, 150) + '.torrent';
  return new Response(t.bytes, {
    headers: {
      'Content-Type': 'application/x-bittorrent',
      'Content-Disposition': `attachment; filename="${fname}"`
    }
  });
}
