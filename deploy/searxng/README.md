# Sigilix self-hosted search — SearXNG (`selfhost` provider)

Stands up an open-source [SearXNG](https://github.com/searxng/searxng) metasearch
instance (no paid API keys) that backs the Deep Research engine's `selfhost`
search leg. Once it's up, point the worker at it via
`SIGILIX_SELFHOST_SEARCH_URL` and Deep Research runs live web search for free.

- `Dockerfile` — bakes our config onto the official `searxng/searxng` image.
- `settings.yml` — enables the JSON API (`formats: [html, json]`) + a curated engine set.
- `limiter.toml` — bot-detection tuning (only active when the limiter is enabled; see below).
- `fly.toml` — Fly.io app config (the recommended host).

## What the worker expects

`src/do/deep-research/search.ts` (`searchSelfhost`) calls:

```
GET {SIGILIX_SELFHOST_SEARCH_URL}/search?q=<query>&format=json
Accept: application/json
Authorization: Bearer <SIGILIX_SELFHOST_SEARCH_TOKEN>   # only if the token is set
```

and parses SearXNG's native response — `{ results: [{ url, title, content }] }`
(`content` → the hit snippet). No adapter changes are needed; SearXNG's
`format=json` shape is exactly what the adapter already reads.

---

## Recommended host: Fly.io

SearXNG is an **always-on HTTP service with a stable public URL**, which is the
natural shape for Fly.io (and a poor fit for Cloudflare Containers — see the note
at the bottom). Fly's free-ish shared-cpu-1x/512MB tier is plenty.

### One-time deploy

From `deploy/searxng/`:

```bash
# 1. Install + auth the Fly CLI (once).
brew install flyctl          # or: curl -L https://fly.io/install.sh | sh
fly auth login

# 2. Create the app WITHOUT deploying yet (reuses this fly.toml; pick a unique name).
fly launch --no-deploy --copy-config --name sigilix-searxng --region sjc

# 3. Set the required SearXNG secret (baked placeholder is replaced at boot).
fly secrets set SEARXNG_SECRET="$(openssl rand -hex 32)"

# 4. (Optional) protect the instance with a bearer token the worker will send.
#    NOTE: SearXNG core does NOT check this header — enforce it with a proxy /
#    Cloudflare Access in front, OR keep the instance on Fly private networking.
#    The value here must match SIGILIX_SELFHOST_SEARCH_TOKEN on the worker.

# 5. Deploy.
fly deploy

# 6. Confirm the JSON API works (should return JSON with a `results` array).
curl -s "https://sigilix-searxng.fly.dev/search?q=cloudflare+workers&format=json" | head -c 400
```

If step 6 returns HTML or a 403, `formats: [html, json]` didn't take — re-check
`settings.yml` was baked into the image (`fly deploy` rebuilds it).

### Point the worker at it (the secret to set)

The worker reads `SIGILIX_SELFHOST_SEARCH_URL` (Sigilix-first) with
`OPENCLAW_SELFHOST_SEARCH_URL` as the legacy fallback. Set the base **origin**
(no trailing `/search`):

```bash
# In the worker repo:
wrangler secret put SIGILIX_SELFHOST_SEARCH_URL
#   → https://sigilix-searxng.fly.dev

# Optional bearer token (must match what your proxy enforces):
wrangler secret put SIGILIX_SELFHOST_SEARCH_TOKEN
```

`selfhost` is already in the default search chain
(`exa,tavily,brave,selfhost,google-pse`), so no chain change is needed — with no
paid keys set, `selfhost` becomes the first (and only) configured provider and
serves every query. To force it first regardless of other keys, set
`SIGILIX_SEARCH_CHAIN=selfhost` (or the `OPENCLAW_` equivalent).

---

## Rate limiting (opt-in)

`settings.yml` ships with `server.limiter: false` because SearXNG's limiter
**requires a Valkey/Redis backend** — an enabled-but-backendless limiter only logs
warnings without limiting. This is a private backend, so the primary protections
are the bearer token + network isolation, not the in-app limiter.

To enable real rate limiting:

1. Add a Valkey instance and expose `SEARXNG_REDIS_URL` to the container
   (`fly redis create`, then `fly secrets set SEARXNG_REDIS_URL=...`).
2. Flip `server.limiter: true` in `settings.yml`.
3. `limiter.toml` is already tuned to keep the JSON API reachable
   (`link_token = false`) — add the worker's egress CIDR to `pass_ip` if you see 429s.
4. `fly deploy`.

---

## Local smoke test (Docker)

```bash
cd deploy/searxng
docker build -t sigilix-searxng .
docker run --rm -p 8080:8080 -e SEARXNG_SECRET="$(openssl rand -hex 32)" sigilix-searxng
# In another shell:
curl -s "http://localhost:8080/search?q=test&format=json" | head -c 400
```

---

## Note: Cloudflare Containers (why NOT the primary path)

The agent-runner uses a Cloudflare Container, but those are **Durable-Object-scoped
and request-lifecycle-bound** — they have no stable public hostname and can only be
reached *through* a Worker/DO proxy, not by an external `SIGILIX_SELFHOST_SEARCH_URL`.
Running SearXNG there would mean adding a new DO class + a fetch-proxy route in the
Worker just so `search.ts` can call back into our own Worker to reach the container
— strictly more moving parts for an always-on service that Fly serves directly.

If you still want it on Cloudflare, the pragmatic path is a Cloudflare Container
fronted by its own DO that proxies `/search`, with `SIGILIX_SELFHOST_SEARCH_URL`
pointing at that Worker route (and the bearer token checked in the DO). That's a
follow-up, not part of this change — Fly is the recommended host today.
