import { error } from '@sveltejs/kit';
import { getImage } from '$lib/server/images.js';

export async function GET({ params }) {
  const img = await getImage(params.kind, Number(params.id));
  if (!img) throw error(404, 'no image');
  return new Response(img.buffer, {
    headers: {
      'content-type': img.contentType,
      'cache-control': 'public, max-age=31536000, immutable'   // cached once, served forever
    }
  });
}
