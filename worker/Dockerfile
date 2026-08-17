# Worker runner: pulls work from the hub, runs job containers via the host
# docker daemon (docker.sock mount), manages checkouts (git).
FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git docker.io ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  # Mounted repos carry host ownership; runners execute as root by default.
  # (safe.directory cannot be passed via -c; git ignores it for security.)
  && git config --global --add safe.directory '*'

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && rm -rf ~/.npm
COPY tsconfig.json ./
COPY src ./src

CMD ["npx", "tsx", "src/runner.ts"]
