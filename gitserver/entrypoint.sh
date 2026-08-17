#!/bin/sh
# Gitserver entrypoint: fcgiwrap socket, then nginx in the foreground.
# fcgiwrap runs as root: repos arrive via host bind mount (foreign uid) and
# git-http-backend must both read and write them (push objects, ref updates).
# The container is a single-operator, compose-internal TLS sidecar.
set -e
mkdir -p /var/run/fcgiwrap
rm -f /var/run/fcgiwrap/fcgiwrap.socket
spawn-fcgi -s /var/run/fcgiwrap/fcgiwrap.socket -M 666 /usr/sbin/fcgiwrap
echo "[gitserver] fcgiwrap listening on unix socket"
exec nginx -g "daemon off;"
