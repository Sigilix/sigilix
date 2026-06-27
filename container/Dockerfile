# Sigilix agent-runner container image.
# Targets linux/amd64 (Cloudflare Containers standard instance).
#
# Build strategy: compile TypeScript with tsc inside the image so the runtime
# only needs Node.js built-ins (no devDependencies at runtime).
FROM node:22-slim

RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install all deps (including devDeps for the compile step) before copying src
# so Docker can cache this layer when only source files change.
COPY package*.json tsconfig.json ./
RUN npm ci

# Compile TypeScript → dist/
COPY src ./src
RUN npx tsc

# Prune devDependencies — the compiled JS only uses Node built-ins at runtime.
RUN npm prune --omit=dev

EXPOSE 8080

CMD ["node", "dist/server.js"]
