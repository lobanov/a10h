# Worker runner: pulls work from the hub and hosts job workloads as
# subprocesses INSIDE this container (no host docker socket — a compromised
# workload is confined here). The image must carry the runtimes the workers
# serve; jobs declare their stack via the advisory `image` field, matched
# through node capability tags.
FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git python3 python-is-python3 ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  # Mounted repos carry host ownership; runners execute as root by default.
  # (safe.directory cannot be passed via -c; git ignores it for security.)
  && git config --global --add safe.directory '*'

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && rm -rf ~/.npm
COPY tsconfig.json ./
COPY src ./src

CMD ["npx", "tsx", "src/worker.ts"]
