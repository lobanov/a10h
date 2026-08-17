#!/usr/bin/env bash
# Fetch local model weights for the vllm service (compose --profile local-llm).
set -euo pipefail
DEST="$(dirname "$0")/../data/vllm-models"
FILE="gemma-4-26B-A4B-it-UD-Q4_K_M.gguf"
URL="https://huggingface.co/unsloth/gemma-4-26B-A4B-it-GGUF/resolve/main/${FILE}"
mkdir -p "$DEST"
if [ -s "$DEST/$FILE" ] && [ "$(stat -c%s "$DEST/$FILE")" -eq 16947541728 ]; then
  echo "already downloaded: $DEST/$FILE"
  exit 0
fi
echo "downloading $URL -> $DEST/$FILE (15.8 GB)"
curl -L --retry 3 -C - -o "$DEST/$FILE" "$URL"
echo "done: $(du -h "$DEST/$FILE" | cut -f1)"
