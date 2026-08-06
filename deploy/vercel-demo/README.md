# demo.films.chrisj.uk — TLS front

This project exists for one reason: **certificate coverage**.

Cloudflare's free Universal SSL covers `chrisj.uk` and `*.chrisj.uk`, but a
wildcard matches only one label. `demo.films.chrisj.uk` is two levels deep, so a
proxied record there would serve a certificate that doesn't match the name and
every browser would refuse it. Covering it on Cloudflare needs Advanced
Certificate Manager, which is a paid add-on.

Vercel issues a free certificate for the exact hostname, at any depth — the same
way `dev.eater.chrisj.uk` already works on this zone. So Vercel terminates TLS
and proxies straight through to the tunnel:

```
demo.films.chrisj.uk    Vercel      free cert for the exact name; DNS-only record
        │  rewrite (vercel.json)
        ▼
films-demo.chrisj.uk    Cloudflare  proxied CNAME -> a3server tunnel
        │
        ▼
films-demo:3000         a3server    the DEMO_MODE=1 container
```

There is no application here — only the rewrite. Everything the visitor sees is
rendered by the container on a3server.

## Deploy

The Vercel project (`films-demo`) is connected to this repository through
Vercel's GitHub integration, with **Root Directory `deploy/vercel-demo`** and
production branch `main`. A push that changes this directory redeploys the
rewrite; a push that doesn't is skipped, because Vercel's automatic ignored-build
step sees no change under the root directory. There is no deploy workflow and no
Vercel token in CI — the integration is the credential.

So the two halves of the demo update by two independent paths, and neither needs
a command run by hand:

| Change | Path |
|---|---|
| `src/**` — the app the visitor sees | `deploy.yml` → GHCR image → Watchtower on a3server |
| `deploy/vercel-demo/**` — the rewrite | Vercel Git integration → production deployment |

### By hand

Only needed to force a redeploy without a commit. The CLI is not installed
globally, so every command goes through `npx` — including the login.
`vercel login` on its own will just say `command not found`, and an
unauthenticated `vercel --prod` reports `The specified token is not valid`,
which means "not logged in".

```bash
cd ~/films/deploy/vercel-demo
npx vercel login          # headless box: it prints a URL + code, open it anywhere
npx vercel --prod
```

`.vercel/` (the project link) is git-ignored, so a fresh clone needs
`npx vercel link` before the CLI will talk to the right project.

### The hostname

`demo.films.chrisj.uk` is attached to the project, and Vercel issued its
certificate for that exact name. The DNS record it needs is in Cloudflare:

```
CNAME  demo.films  ->  ad9ed1926776eae8.vercel-dns-017.com   (proxied: false)
```

**The grey cloud is not optional.** Proxying it would put Cloudflare's edge back
in front of a name its own certificate does not cover, which is the problem this
whole arrangement exists to avoid — the same reason `eater` and `rcr` are
unproxied on this zone. The CNAME target is account-specific; if it ever needs
re-deriving, `GET /v6/domains/demo.films.chrisj.uk/config` returns it as
`recommendedCNAME`.

## Checks

```bash
curl -sI https://demo.films.chrisj.uk | head -1          # 200
curl -s https://demo.films.chrisj.uk | grep -c topstrip  # 1 -> demo build is live
```

Two visitors must not see each other's lists:

```bash
curl -s -c a.txt -b a.txt -X POST https://demo.films.chrisj.uk/api/status \
  -H 'content-type: application/json' -d '{"id_tspdt":2425,"kind":"seen","on":true}'
curl -s -c b.txt -b b.txt 'https://demo.films.chrisj.uk/api/films?status=seen' \
  | head -c 60      # "total":0 for the second visitor
```

## Notes

- The origin `films-demo.chrisj.uk` is publicly reachable too — Vercel needs a
  public origin to proxy to. It serves the identical demo. `ORIGIN` on the
  container is the Vercel hostname, so that is the canonical name in generated
  URLs and the one SvelteKit's CSRF check accepts for form posts.
- If you later buy Advanced Certificate Manager, this project becomes
  unnecessary: point `demo.films.chrisj.uk` straight at the tunnel (proxied) and
  delete it.
