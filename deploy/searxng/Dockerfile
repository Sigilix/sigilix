# Sigilix self-hosted search — SearXNG (the `selfhost` search provider).
#
# SearXNG is an open-source metasearch engine (no paid API keys). This image
# bakes our config onto the official upstream image so `fly deploy` / `docker run`
# is reproducible with no host-side volume wiring.
#
# The upstream entrypoint substitutes $SEARXNG_SECRET into the `ultrasecretkey`
# placeholder in settings.yml at container start — set that secret at deploy time
# (see README.md), never commit a real key.
#
# The instance exposes SearXNG's JSON API at GET /search?q=<query>&format=json,
# which is exactly what src/do/deep-research/search.ts (searchSelfhost) calls.
FROM searxng/searxng:latest

# Baked config: enables the JSON output format + a curated engine set (settings.yml)
# and the bot-detection/limiter tuning (limiter.toml, used only when the limiter is
# enabled — see README "Rate limiting").
COPY settings.yml /etc/searxng/settings.yml
COPY limiter.toml /etc/searxng/limiter.toml

# Upstream serves on 8080.
EXPOSE 8080
