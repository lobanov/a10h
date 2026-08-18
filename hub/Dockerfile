# Hub: supervisor + agents (pi SDK) + dashboard statics.
FROM node:22-slim

# git: hub-side repo access (gitsvc.ts reads/merges bare repos, upstream sync)
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/* \
  # Bare repos arrive via host bind mount (foreign uid); hub-side git
  # (gitsvc reads, syncs, merges) must not trip ownership checks.
  && git config --system --add safe.directory '*'

WORKDIR /app
# Build context is the REPO ROOT (compose) so framework-side skills/ can be
# baked in (role-shaping skills load into agent session prompts).
COPY hub/package.json hub/package-lock.json* ./
RUN npm install --omit=dev && rm -rf ~/.npm
COPY hub/tsconfig.json ./
COPY hub/src ./src
COPY hub/public ./public
COPY skills ./skills

EXPOSE 8080
CMD ["npx", "tsx", "src/index.ts"]
