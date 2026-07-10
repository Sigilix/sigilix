# Sigilix agent-runner container image.
# Targets linux/amd64 (Cloudflare Containers standard instance).
#
# Build strategy: compile TypeScript with tsc inside the image so the runtime
# only needs Node.js built-ins (no devDependencies at runtime).
FROM --platform=linux/amd64 node:22-slim

RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

# Provision the full agent engine: the published Sigilix CLI (an opencode fork).
# Pinned — bump deliberately (a new CLI can change the permission/tool surface the
# runner depends on). The bin is `sigilix`; cli-agent.ts reads SIGILIX_CLI_BIN.
# Verified: this bun-compiled bin runs on linux/amd64 under node:22-slim.
RUN npm i -g @sigilix/cli@1.17.14 && sigilix --version
ENV SIGILIX_CLI_BIN=sigilix

WORKDIR /app

# Install all deps (including devDeps for the compile step) before copying src
# so Docker can cache this layer when only source files change.
COPY package*.json tsconfig.json tsconfig.build.json ./
RUN npm ci

# Compile TypeScript → dist/ (tsconfig.build.json excludes *.test.ts so the
# image ships only runtime files — no tests, no vitest refs after the prune).
COPY src ./src
RUN npx tsc -p tsconfig.build.json

# Prune devDependencies — the compiled JS only uses Node built-ins at runtime.
RUN npm prune --omit=dev

EXPOSE 8080

CMD ["node", "dist/server.js"]
