import { error } from '@sveltejs/kit';
import { encodedFile, encodedExists, fileResponse } from '$lib/server/media.js';

// Download the iGPU-encoded copy (range-capable).
export function GET({ params, request }) {
  const id = Number(params.id);
  if (!Number.isSafeInteger(id) || id === 0 || !encodedExists(id)) throw error(404, 'No encoded copy is available.');
  return fileResponse(encodedFile(id), request.headers.get('range'), { downloadName: `film-${id}.mp4` });
}
