#!/bin/sh
# hf-mount sidecar entrypoint: wait for the mount dir, then start the FUSE
# mount in the FOREGROUND (the daemon wrapper backgrounds itself; we hold the
# pod alive and restart on exit via compose policy).
set -e
: "${HF_BUCKET:?HF_BUCKET required (user/bucket or user/bucket/subfolder)}"
: "${HF_TOKEN:?HF_TOKEN required}"
MOUNT_POINT="${HF_MOUNT_POINT:-/hf-store/hf}"
ARGS="--hf-token $HF_TOKEN"
[ "$READ_ONLY" = "1" ] && ARGS="$ARGS --read-only"

mkdir -p "$MOUNT_POINT" 2>/dev/null || true
echo "[hfmount] mounting bucket $HF_BUCKET at $MOUNT_POINT (read_only=${READ_ONLY:-0})"
exec /usr/local/lib/hf-mount/hf-mount-fuse $ARGS bucket "$HF_BUCKET" "$MOUNT_POINT"
