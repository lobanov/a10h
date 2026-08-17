#!/usr/bin/env bash
# Dependency-free progress emitter for job authors (protocol v0).
# Usage: source emit.sh; em_progress 42 "epoch 7/16" 61 '{"loss":0.31}'; em_done 1 '{"loss":0.2}'
# Note: t is integer seconds since source (schema requires number >= 0).
_EMIT_T0=${EPOCHSECONDS:-$(date +%s)}
_emit() { printf '%s\n' "$1" >> progress.jsonl; }
em_progress() { # pct stage [eta_s] [metrics_json]
  local t=$(( ${EPOCHSECONDS:-$(date +%s)} - _EMIT_T0 ))
  local ev="{\"t\":$t,\"pct\":$1,\"stage\":\"$2\""
  [ -n "$3" ] && ev="$ev,\"eta_s\":$3"
  [ -n "$4" ] && ev="$ev,\"metrics\":$4"
  _emit "$ev}"
}
em_done() { # succeeded(0|1) [metrics_json]
  local t=$(( ${EPOCHSECONDS:-$(date +%s)} - _EMIT_T0 ))
  local ev="{\"t\":$t,\"pct\":100.0,\"eta_s\":0,\"stage\":\"done\""
  [ -n "$2" ] && ev="$ev,\"metrics\":$2"
  _emit "$ev,\"state\":\"$([ "$1" = 1 ] && echo succeeded || echo failed)\"}"
}
