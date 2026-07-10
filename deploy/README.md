# Deployment

`https://film.chrisj.uk` is served from the home server (`a3server`) by a small
Docker Compose stack, exposed through the existing **Cloudflare Tunnel** (the
same `cloudflared` that serves `which.chrisj.uk`) and gated by **Cloudflare
Access** (SSO) — no open inbound ports, home IP hidden, TLS at Cloudflare's edge.

## Pieces

- **film** — the SvelteKit (`adapter-node`) server running `node build` on
  Node 22. Its SQLite DB and poster cache are **bind-mounted** from the host so
  they survive image updates:
  - `/srv/film/tspdt.db` (+ `-wal`/`-shm`) — the catalogue + watchlist/seen +
    metadata cache, built by `tspdt_sync.py` (see below).
  - `/srv/film/.postercache/` — downloaded poster/backdrop art.

  The container attaches to the `which_which` docker network so the existing
  cloudflared can reach it at `http://film:3000`. Only `127.0.0.1:8100` is
  published on the host, for local health checks.
- **watchtower** — auto-pulls new images CI pushes to GHCR. Scoped to `film`
  only, so it never touches the rest of the homelab.

## CI/CD

`.github/workflows/deploy.yml` builds `deploy/Dockerfile` and pushes
`ghcr.io/chrisjuresh/film:latest` on every push to `main` that touches `site/`
(using the built-in `GITHUB_TOKEN` — no secrets to configure). Watchtower on the
server pulls it within ~2 min. Rollback = re-run an older workflow or
`docker compose pull` a pinned tag.

> **One-time GitHub step:** make the `film` GHCR package **public** (GitHub →
> your profile → Packages → `film` → Package settings → Change visibility), so
> Watchtower can pull it without credentials. Otherwise run
> `docker login ghcr.io` on the server once.

## Cloudflare (one-time, in the dashboard — can't be scripted from the server)

The `film.chrisj.uk` tunnel ingress + DNS must be added in the Cloudflare Zero
Trust dashboard (token-based tunnels keep their ingress rules there, not on the
host):

1. **Networks → Tunnels →** the tunnel that already serves `which.chrisj.uk` →
   **Public Hostnames → Add a public hostname**:
   - Subdomain `film`, domain `chrisj.uk`
   - Service **HTTP** → `film:3000`
   (adding it here auto-creates the `film` DNS record).
2. **Access → Applications → Add** a self-hosted app for `film.chrisj.uk` with a
   policy allowing your identity (same as `a3.chrisj.uk`).

## Per-user watchlist / seen

Watchlist and "seen" state are **per Cloudflare-Access user**: `hooks.server.js`
reads the `Cf-Access-Authenticated-User-Email` header that Access injects and
keys the `user_status` table on it. This is only safe because the container's
port is **not** published to the LAN — the app is reachable solely through the
Access-gated tunnel, so the header can't be forged by an outside client. Do not
expose port 3000 publicly. (With no Access in front — dev or the loopback health
check — everyone shares a single `local` identity.)

## First-time / manual deploy (on the server)

```bash
# 1. Build the database (host, one-time — needs xlrd):
python3 -m venv ~/tspdt/.venv
~/tspdt/.venv/bin/pip install -r ~/tspdt/requirements.txt
sudo mkdir -p /srv/film && sudo chown 1001:1001 /srv/film   # 1001 = chris
cd /srv/film && ~/tspdt/.venv/bin/python ~/tspdt/tspdt_sync.py

# 2. (optional) API keys:
cp ~/tspdt/deploy/.env.example ~/tspdt/deploy/.env   # then edit

# 3. Build + start (CI publishes the image later; this builds it locally now):
cd ~/tspdt/deploy
docker compose build film
docker compose up -d
curl -sSf http://127.0.0.1:8100/ >/dev/null && echo "film is up"
```

## Refreshing the catalogue (new TSPDT edition / data)

```bash
cd /srv/film && ~/tspdt/.venv/bin/python ~/tspdt/tspdt_sync.py   # idempotent
# no restart needed; the running server reads the updated DB live.
```
