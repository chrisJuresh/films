import { reconciliation } from '$lib/server/db.js';

export function load({ locals }) {
  return reconciliation(locals.user);
}
