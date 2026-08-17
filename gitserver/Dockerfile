# Gitserver: serves bare research repos over smart HTTPS (DESIGN.md §3.2.1).
# nginx terminates TLS (internal CA), validates the pusher token via the hub's
# auth endpoint (auth_request), and proxies git-http-backend through fcgiwrap.
# All push policy lives in the hub (thin pre-receive hook) — never here.
FROM nginx:1.27-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    git fcgiwrap spawn-fcgi curl jq ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/* \
  # Repos arrive via host bind mount (foreign uid); git-http-backend must
  # serve them regardless of ownership.
  && git config --system --add safe.directory '*'

COPY nginx.conf /etc/nginx/conf.d/gitserver.conf
RUN rm -f /etc/nginx/conf.d/default.conf
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 443
ENTRYPOINT ["/entrypoint.sh"]
