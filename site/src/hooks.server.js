// Identity for per-user state (watchlist / seen) comes from Cloudflare Access.
// Access authenticates every request at the edge and injects the signed-in
// user's email as a request header on everything it proxies through the tunnel.
//
// Trust model: this app is reachable ONLY through the Access-gated tunnel — the
// container's port is not published to the LAN (see deploy/compose.yaml) — so
// the header cannot be set by an outside client. When Access is not in front
// (local dev, or the loopback health check), there is no header and everyone
// shares a single 'local' identity, which is the old shared behaviour.
export async function handle({ event, resolve }) {
  const email = event.request.headers.get('cf-access-authenticated-user-email');
  event.locals.user = (email || process.env.TSPDT_DEFAULT_USER || 'local').trim().toLowerCase();
  return resolve(event);
}
