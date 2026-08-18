# hf-mount sidecar (DESIGN.md §3.3): mounts the project HF Bucket at
# /hf-store/hf with a FUSE backend. Runs as root with SYS_ADMIN + /dev/fuse
# (mounting requires it); the bind is `shared` so the submount propagates to
# the host path and into hub/workers (rslave binds). The single HF_TOKEN
# lives in this sidecar only — workers hold no HF tokens by design.
FROM debian:bookworm-slim

ARG HF_MOUNT_VERSION=v0.9.2
ARG HF_MOUNT_ARCH=aarch64-linux

RUN apt-get update \
  && apt-get install -y --no-install-recommends fuse3 ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /usr/local/lib/hf-mount \
  && for b in hf-mount hf-mount-fuse; do \
    curl -fsSL -o /usr/local/lib/hf-mount/$b \
      "https://github.com/huggingface/hf-mount/releases/download/${HF_MOUNT_VERSION}/${b}-${HF_MOUNT_ARCH}" \
    && chmod +x /usr/local/lib/hf-mount/$b; \
  done \
  && ln -s /usr/local/lib/hf-mount/hf-mount /usr/local/bin/hf-mount

# Expect: HF_TOKEN, HF_BUCKET (may include a subfolder: user/bucket/subdir),
# optional READ_ONLY=1.
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
