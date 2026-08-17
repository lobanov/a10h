# Spoke runner: pulls work from the hub, runs job containers via the host
# docker daemon (docker.sock mount), manages checkouts (git).
FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git docker.io ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && rm -rf ~/.npm
COPY tsconfig.json ./
COPY src ./src

CMD ["npx", "tsx", "src/runner.ts"]
