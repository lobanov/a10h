#!/usr/bin/env bash
# Fetch local model weights for the vllm service (compose --profile local-llm).
# Layout: data/vllm-models/model/{config.json, <gguf>} — vLLM needs the
# transformers config sidecar next to the GGUF.
set -euo pipefail
DEST="$(dirname "$0")/../data/vllm-models/model"
FILE="gemma-4-26B-A4B-it-UD-Q4_K_M.gguf"
BASE="https://huggingface.co/unsloth/gemma-4-26B-A4B-it-GGUF/resolve/main"
GGUF_BYTES=16947541728
mkdir -p "$DEST"
if [ ! -s "$DEST/config.json" ]; then
  echo "fetching config.json"
  curl -sL --retry 3 -o "$DEST/config.json" "$BASE/config.json"
fi
if [ -s "$DEST/$FILE" ] && [ "$(stat -c%s "$DEST/$FILE")" -eq "$GGUF_BYTES" ]; then
  echo "already downloaded: $DEST/$FILE"
  exit 0
fi
echo "downloading $BASE/$FILE -> $DEST/$FILE (15.8 GB)"
curl -L --retry 3 -C - -o "$DEST/$FILE" "$BASE/$FILE"
actual=$(stat -c%s "$DEST/$FILE")
[ "$actual" -eq "$GGUF_BYTES" ] || { echo "size mismatch: $actual != $GGUF_BYTES"; exit 1; }
echo "done: $(du -h "$DEST/$FILE" | cut -f1)"
