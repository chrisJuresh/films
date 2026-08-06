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

Pushing a change to anything under `deploy/vercel-demo/` on `main` redeploys it:
[`.github/workflows/demo-vercel.yml`](../../.github/workflows/demo-vercel.yml)
runs `vercel deploy --prod` for this directory. It needs one repository secret
and two repository variables, all set once:

```bash
gh secret set VERCEL_TOKEN                     # Vercel -> Account Settings -> Tokens
gh variable set VERCEL_ORG_ID --body "$(python3 -c 'import json;print(json.load(open(".vercel/project.json"))["orgId"])')"
gh variable set VERCEL_PROJECT_ID --body "$(python3 -c 'import json;print(json.load(open(".vercel/project.json"))["projectId"])')"
```

Nothing here is built, so the workflow deliberately ignores the rest of the
repo — a change to `src/**` reaches the demo as a container image (`deploy.yml`
→ GHCR → Watchtower), not through Vercel.

### By hand, and first-time setup

The CLI is not installed globally, so every command goes through `npx` —
including the login. `vercel login` on its own will just say
`command not found`, and an unauthenticated `vercel --prod` reports
`The specified token is not valid`, which means "not logged in".

```bash
cd ~/films/deploy/vercel-demo
npx vercel login          # headless box: it prints a URL + code, open it anywhere
npx vercel --prod
```

`vercel --prod` asks a few setup questions the first time:

| Prompt | Answer |
|---|---|
| Set up and deploy? | `y` |
| Which scope? | your personal account |
| Link to existing project? | `n` |
| Project name | `films-demo` |
| In which directory is your code located? | `./` |
| Modify build settings? | `n` — there is nothing to build |

Then attach the hostname **in the dashboard** (Project → Settings → Domains →
Add). That page prints the exact DNS record to create and then tracks
certificate issuance, which the CLI does not. `npx vercel domains add` only
registers a domain against the account, so it is the wrong command here.

The record will be a CNAME to `cname.vercel-dns.com` (or an A record to
`76.76.21.21`). Add it in Cloudflare **with the proxy off — grey cloud,
`proxied: false`** — exactly like the existing `eater` / `rcr` records. Proxying
it would put Cloudflare's edge back in front of a name its certificate does not
cover, which is the problem this whole arrangement exists to avoid.

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
