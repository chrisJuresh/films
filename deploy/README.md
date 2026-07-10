# Deployment

`https://films.chrisj.uk` is served from the home server (`a3server`) by a small
Docker Compose stack, exposed through the shared **Cloudflare Tunnel** (the
`a3server` tunnel, which also serves `which.chrisj.uk` and `a3.chrisj.uk`) and
gated by **Cloudflare Access** (SSO) — no open inbound ports, home IP hidden,
TLS at Cloudflare's edge.

## Pieces

- **films** — the SvelteKit (`adapter-node`) server running `node build` on
  Node 22. Its SQLite DB and poster cache are **bind-mounted** from the host so
  they survive image updates:
  - `/srv/films/tspdt.db` (+ `-wal`/`-shm`) — the catalogue + watchlist/seen +
    metadata cache, built by `sync/tspdt_sync.py` (see below).
  - `/srv/films/.postercache/` — downloaded poster/backdrop art.

  The container attaches to the shared **`a3server`** docker network so the
  cloudflared tunnel can reach it at `http://films:3000`. Only `127.0.0.1:8100`
  is published on the host, for local health checks.
- **watchtower** — auto-pulls new images CI pushes to GHCR. Scoped to `films`
  only, so it never touches the rest of the homelab.

## Shared edge network

All publicly-served origins on this box share one cloudflared tunnel over one
docker network, both named **`a3server`**. The tunnel itself is defined in the
`which` project's compose; other stacks (this one) attach to the network as
`external`. Create it once (idempotent):

```bash
docker network create a3server
```

## CI/CD

`.github/workflows/deploy.yml` builds `deploy/Dockerfile` and pushes
`ghcr.io/chrisjuresh/films:latest` on every push to `main` that touches the app
(using the built-in `GITHUB_TOKEN` — no secrets to configure). Watchtower on the
server pulls it within ~2 min. Rollback = re-run an older workflow or
`docker compose pull` a pinned tag.

> **GHCR visibility:** because the `films` repo is public, the published `films`
> package inherits public visibility, so Watchtower pulls it anonymously — no
> action needed. If the repo is ever made private, either make the package
> public (GitHub → Packages → `films` → Package settings → visibility) or run
> `docker login ghcr.io` on the server and mount the config into Watchtower.

## Cloudflare (one-time, in the dashboard or via API)

Token-based tunnels keep their ingress rules in Cloudflare, not on the host:

1. **Networks → Tunnels → `a3server` → Public Hostnames → Add**:
   - Subdomain `films`, domain `chrisj.uk`
   - Service **HTTP** → `films:3000`
   (also create the `films` CNAME → `<tunnel-id>.cfargotunnel.com`, proxied).
2. **Access → Applications → Add** a self-hosted app for `films.chrisj.uk` with a
   policy allowing your identity (same as `a3.chrisj.uk`).

## Per-user watchlist / seen

Watchlist and "seen" state are **per Cloudflare-Access user**: `src/hooks.server.js`
reads the `Cf-Access-Authenticated-User-Email` header that Access injects and
keys the `user_status` table on it. This is only safe because the container's
port is **not** published to the LAN — the app is reachable solely through the
Access-gated tunnel, so the header can't be forged by an outside client. Do not
expose port 3000 publicly. (With no Access in front — dev or the loopback health
check — everyone shares a single `local` identity.)

## First-time / manual deploy (on the server)

```bash
# 1. Build the database (host, one-time — needs xlrd):
python3 -m venv ~/films/.venv
~/films/.venv/bin/pip install -r ~/films/sync/requirements.txt
sudo mkdir -p /srv/films && sudo chown 1001:1001 /srv/films   # 1001 = chris
cd /srv/films && ~/films/.venv/bin/python ~/films/sync/tspdt_sync.py

# 2. (optional) API keys:
cp ~/films/deploy/.env.example ~/films/deploy/.env   # then edit

# 3. Build + start (CI publishes the image later; this builds it locally now):
docker network create a3server 2>/dev/null || true
cd ~/films/deploy
docker compose build films
docker compose up -d
curl -sSf http://127.0.0.1:8100/ >/dev/null && echo "films is up"
```

## Refreshing the catalogue (new TSPDT edition / data)

```bash
cd /srv/films && ~/films/.venv/bin/python ~/films/sync/tspdt_sync.py   # idempotent
# no restart needed; the running server reads the updated DB live.
```
