#!/usr/bin/env bash
# R1 bootstrap (DESIGN.md §3.2.1, §4): internal CA, gitserver+hub TLS certs,
# worker git tokens + policy map, bare repos seeded from examples/ (demo.git),
# thin pre-receive hooks, optional GitHub/upstream remotes.
#
# Idempotent: every step creates only what is missing. Re-run safe.
#   scripts/bootstrap-git.sh [--force]   (--force regenerates CA/certs/tokens)
#
# Optional environment:
#   WORKER_IDS="worker-a worker-b"       worker token ids (default compose pair)
#   GIT_UPSTREAM_DEMO=<url>              upstream remote for demo.git (GitHub)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GIT="$ROOT/data/git"
CA="$GIT/ca"; TLS="$GIT/tls"; TOKENS="$GIT/tokens"
REPOS="$ROOT/data/repos"
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

WORKER_IDS=${WORKER_IDS:-"worker-a worker-b"}

mkdir -p "$CA" "$TLS" "$TOKENS" "$REPOS"

# --- 1. Internal CA (10y) -------------------------------------------------
if [ "$FORCE" -eq 1 ] || [ ! -f "$CA/ca.key" ]; then
  [ -f "$CA/ca.key" ] && rm -f "$CA/ca.key" "$CA/ca.crt"
  openssl genrsa -out "$CA/ca.key" 4096 2>/dev/null
  openssl req -x509 -new -nodes -key "$CA/ca.key" -sha256 -days 3650 \
    -out "$CA/ca.crt" -subj "/CN=Pi Autoresearch Git CA/O=autoresearch" 2>/dev/null
  echo "[bootstrap] CA created: $CA/ca.crt"
else
  echo "[bootstrap] CA exists (kept)"
fi

issue_cert() { # name dns-san...
  local name="$1"; shift
  local san="" d
  for d in "$@"; do san="${san}DNS:${d},"; done
  san="${san%,}"
  if [ "$FORCE" -eq 1 ] || [ ! -f "$TLS/$name.key" ]; then
    openssl genrsa -out "$TLS/$name.key" 2048 2>/dev/null
    openssl req -new -key "$TLS/$name.key" \
      -out "$TLS/$name.csr" -subj "/CN=$name/O=autoresearch" 2>/dev/null
    printf 'subjectAltName=%s\nextendedKeyUsage=serverAuth\n' "$san" > "$TLS/$name.ext"
    openssl x509 -req -in "$TLS/$name.csr" -CA "$CA/ca.crt" -CAkey "$CA/ca.key" \
      -CAcreateserial -out "$TLS/$name.crt" -days 825 -sha256 \
      -extfile "$TLS/$name.ext" 2>/dev/null
    echo "[bootstrap] TLS cert issued: $name ($san)"
  else
    echo "[bootstrap] TLS cert exists: $name (kept)"
  fi
}

# --- 2. Server certs: gitserver (443) + hub API (8080, same CA) ------------
issue_cert gitserver gitserver localhost
issue_cert hub hub localhost

# --- 3. Worker tokens + policy map -----------------------------------------
POLICY="$GIT/policy.json"
gen_token() { openssl rand -hex 24; }

node - "$POLICY" "$TOKENS" $WORKER_IDS <<'EOF'
// Idempotent: create missing tokens, merge into policy, write both.
const fs = require("fs");
const [policyPath, tokensDir, ...workerIds] = process.argv.slice(2);
let policy = { version: 1, tokens: {} };
try { policy = JSON.parse(fs.readFileSync(policyPath, "utf8")); } catch {}
let changed = false;
for (const id of workerIds) {
  const tf = `${tokensDir}/${id}.token`;
  let token;
  try { token = fs.readFileSync(tf, "utf8").trim(); } catch {
    token = require("crypto").randomBytes(24).toString("hex");
    fs.writeFileSync(tf, token + "\n", { mode: 0o600 });
    changed = true;
    console.log(`[bootstrap] token issued: ${id}`);
  }
  if (!policy.tokens[token]) {
    policy.tokens[token] = { role: "worker", node: id, repos: ["demo"] };
    changed = true;
  }
}
if (changed || !fs.existsSync(policyPath)) {
  fs.writeFileSync(policyPath, JSON.stringify(policy, null, 2) + "\n");
  console.log(`[bootstrap] policy map written: ${policyPath}`);
} else {
  console.log("[bootstrap] tokens + policy exist (kept)");
}
EOF

# --- 4. Bare repos, seeded from examples/ -----------------------------------
seed_repo() { # $1=name $2=source_dir
  local name="$1"
  local src="$2"
  local bare="$REPOS/$name.git"
  if [ -d "$bare" ]; then
    echo "[bootstrap] bare repo exists: $name.git (kept)"
    return
  fi
  local tmp
  tmp="$(mktemp -d)"
  cp -r "$src/." "$tmp/"
  rm -rf "$tmp/runs"
  git -C "$tmp" init -q -b main
  git -C "$tmp" add -A
  git -C "$tmp" -c user.name=bootstrap -c user.email=bootstrap@local \
    commit -q -m "seed: $name from $(basename "$src")"
  git init -q --bare -b main "$bare"
  git -C "$tmp" push -q "$bare" main:main
  rm -rf "$tmp"
  echo "[bootstrap] bare repo seeded: $name.git <- $src"
}

seed_repo demo "$ROOT/examples/demo-project"

# --- 5. Thin pre-receive hook into every bare repo ---------------------------
for bare in "$REPOS"/*.git; do
  [ -d "$bare" ] || continue
  install -m 755 "$ROOT/gitserver/hooks/pre-receive" "$bare/hooks/pre-receive"
done
echo "[bootstrap] pre-receive hooks installed"

# --- 6. Optional upstream (GitHub) remotes -----------------------------------
# Per-repo upstream URL via GIT_UPSTREAM_<NAME>=<url> (lowercased name) or an
# existing remotes.json. The hub syncs main from upstream (ff-only).
REMOTES_JSON="$GIT/remotes.json"
upstream_for() { # name -> url or ""
  local var
  var="GIT_UPSTREAM_$(printf '%s' "$1" | tr '[:lower:]-' '[:upper:]_')"
  printf '%s' "${!var:-}"
}
for bare in "$REPOS"/*.git; do
  [ -d "$bare" ] || continue
  name="$(basename "$bare" .git)"
  url="$(upstream_for "$name")"
  if [ -n "$url" ]; then
    if git --git-dir="$bare" remote get-url upstream >/dev/null 2>&1; then
      git --git-dir="$bare" remote set-url upstream "$url"
    else
      git --git-dir="$bare" remote add upstream "$url"
    fi
    echo "[bootstrap] upstream wired: $name -> $url"
  fi
done

echo "[bootstrap] done."
