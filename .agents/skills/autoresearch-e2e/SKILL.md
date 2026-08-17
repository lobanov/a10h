---
name: autoresearch-e2e
description: Configure, run, and troubleshoot end-to-end tests of the Pi Autoresearch Lab framework (docker-compose stack: hub, postgres, workers, local llama.cpp LLM). Use when running scripts/e2e-demo.mjs, debugging stuck demo runs ("approval pending", "no inference", jobs not leasing), setting up .env/model weights, or verifying lease-requeue/agent behavior. Hard-won lessons from real incidents included.
license: MIT
compatibility: Requires docker + compose v2, node 22+, this repo deployed per docker-compose.yml. GPU optional (local auditor model).
---

# Autoresearch E2E — configure, run, troubleshoot

Paths below are relative to the repo root (`~/autoresearch`). "Green" means
`node scripts/e2e-demo.mjs` prints **`ALL CHECKS PASSED`** (20 checks:
approval blocking, 2-worker scheduling, gate pass/fail, repair→escalation
with director note, auditor audits, schema-valid artifacts, plan done).

## 1. Configure (once per machine)

```bash
cp .env.example .env
# REQUIRED for director agent notes: Z_AI_API_KEY=... (remote GLM-5.3)
# Auditor runs local by default (AUDITOR_MODEL=local/gemma-4-26b-it).

./scripts/fetch-models.sh        # 15.8 GB GGUF → data/vllm-models/model/ (~9 min)
docker compose up -d postgres hub
docker compose --profile worker up -d        # worker-a + worker-b
docker compose --profile local-llm up -d llamacpp   # optional local auditor
```

Verify: `docker compose --profile worker --profile local-llm ps` → all
`Up`/`healthy`; `curl -s localhost:8080/api/health` → `{"ok":true}`; hub log
line `agents enabled (auditor=local/gemma-4-26b-it, director=z.ai/glm-5.3)`.

Model facts (do not rediscover):
- **vLLM cannot serve GGUF** (0.27 removed GGUF paths; errors like
  *"config file … is not a valid JSON file"*, *"Unknown config format gguf"*,
  *"Cannot find any model weights"*). Use `ghcr.io/ggml-org/llama.cpp:server-cuda`
  (arm64+CUDA OK on GB10/DGX Spark; loads in ~32 s) — same `/v1` API.
- The unsloth GGUF repo ships **no tokenizer files**; llama.cpp doesn't need
  them (GGUF embeds everything). Only vLLM would want sidecars — skip vLLM.
- `--hf-overrides` with compose *string* `command:` gets mangled by shlex →
  use YAML **list-form** `command:` for anything containing quotes.
## 2. Run the E2E

```bash
# Clean state between runs (stale plans/escalations confuse assertions):
docker exec autoresearch-postgres-1 psql -U autoresearch -d autoresearch \
  -c "TRUNCATE nodes, jobs, job_events, artifacts, plans, activities, gate_results, approvals, agent_log;"

# ALWAYS run in background and poll — agent turns (serialized, local model
# ~24 s/audit, director on GLM-5.3) make the full run take 3–5+ minutes,
# which can exceed tool timeouts if run in the foreground:
nohup node scripts/e2e-demo.mjs http://localhost:8080 > /tmp/e2e.log 2>&1 &
```

Monitor (never assume; always look):
```bash
tail -5 /tmp/e2e.log
curl -s localhost:8080/api/state | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const s=JSON.parse(d);console.log('plans:',s.plans.map(p=>p.id+':'+p.status).join(', '));console.log('acts:',s.activities.map(a=>a.id+':'+a.status).join(', '));console.log('agent_log:',s.agent_log.slice(0,3).map(a=>a.role+'/'+a.event).join(', ')||'none')})"
docker logs --since 5m autoresearch-worker-a-1 2>&1 | tail -8
```

Expected timeline: activities terminal in <60 s → director note (GLM-5.3,
~1–2 min; e2e polls up to 6 min) → escalation resolved → plan done →
auditor notes land asynchronously (e2e needs ≥1).

Live-event / SSE proof: `curl -sN localhost:8080/api/stream > /tmp/sse.log`
then grep for `requeued":true`, `gate`, `agent` events.

## 3. Troubleshoot — symptom → diagnosis → fix

**"Dashboard shows approval pending, no inference running"**
First *classify* the approval via `/api/state`:
- `plan_approval` pending + plan `pending_approval` + 0 jobs → **expected**:
  approval blocks execution. Approve it (dashboard or
  `POST /api/approvals/<id> {"action":"approve"}`).
- `escalation` pending + activities stuck → **by design**: a gate failed twice
  and awaits operator disposition; the director note attaches asynchronously.
  Verify inference happened: `agent_log` shows `director/recommendation_recorded`
  or `auditor/audit_recorded`; `docker logs autoresearch-llamacpp-1 | grep -c "prompt eval"`.
- No `agent_log` rows at all and no llamacpp traffic → check hub env
  (`agents enabled` log line), `LOCAL_LLM_BASE_URL` reachability, and
  `/tmp/autoresearch-models.json` generation inside the hub container.

**Jobs stay `queued`, no node leases them**
- Workers report `busy` forever after a failed checkout → busy-flag leak
  (fixed: checkout now inside try/finally). If it recurs, worker logs show the
  original error before the wedge — fix that error, restart the worker.
- Node-tag mismatch: compare `nodes[].tags` (from `NODE_TAGS` env) against job
  `requirements` (e.g. `gpu:true` jobs wait for a gpu-tagged worker).
- Manual pull probe: `curl -s -w '%{http_code}' 'localhost:8080/api/work?node=probe'`
  → `204` = hub has nothing grantable; `200` = grant path works.

**Worker logs: "detected dubious ownership in repository at '/repo/.git'"**
Git **ignores** `safe.directory` via `-c` (security). It must be global config
— already baked into `worker/Dockerfile`
(`git config --global --add safe.directory '*'`). If a custom image lacks it,
add it there; never try to pass `-c safe.directory=*`.

**Worker logs: "Conflict. The container name … is already in use"**
Obsolete — workers no longer launch job containers at all (workloads are
subprocesses; see next entry). Historical root cause kept in incidents.md.

**Workload subprocess fails to start / `python: command not found`**
Workers host workloads as **subprocesses inside the worker container** (no
docker socket — by design, security). The worker image must carry the runtimes
it serves (`worker/Dockerfile` installs python3 + `python-is-python3`).
Advertise runtimes via `NODE_TAGS` (e.g. `python:3.12`) and match with job
`requirements.tags`. Workload env is minimal (PATH, HOME=/tmp, LANG) plus
explicit `JOB_ENV_*` passthrough — missing env is usually a passthrough gap,
not a bug.

**Job requeued while visibly running (`sleep`-style silent jobs)**
Silent jobs emit no progress events → lease never renewed → hub requeues a
live job. Fixed: runner posts `running` every 10 s; hub `/status` running
renews the lease; stale-attempt posts get `409`. Kill-test recipe (the proof
that this all works) is in [references/incidents.md](references/incidents.md).

**Agent checks fail: `no_tool_call` in agent_log**
The SDK allowlist `tools: []` silently disables `customTools` too. Use
`noTools: "builtin"` to keep custom tools while disabling built-ins.

**Agent checks fail on time / `turn_error: agent timeout`**
Parallel agent turns against one provider rate-limit and time out. Fixed by
serialized per-role turn queues (180 s timeout). E2E wait loops must tolerate
minutes — don't shorten them.

**Hub restart dies with `EADDRINUSE :8080`**
`npm start`/`npx tsx` spawns a child that outlives the parent PID. Kill by
pattern, not PID file: `pkill -f "src/index.ts"`, then verify with
`pgrep -fa "tsx src"` before restarting.

**`metrics.json` evidence missing / gate fails on `evidence_json`**
Evidence paths in `outputs.evidence` are **relative to the project root**
(the workspace mount), and upstream evidence is materialized from transitive
deps' artifacts — verify with `GET /api/jobs/<id>/artifacts`.

**Root-owned files under `data/work-*`**
Workload subprocesses run as the worker container user (root by default) and
write into the bind-mounted work dir; the worker cleans checkouts itself. If
a worker dies mid-job, clear leftovers with
`docker run --rm -v <dir>:/w alpine rm -rf /w/<job>`.

**BDD suite oddities** (hub/tests, worker/tests): scenarios share the scratch
DB → truncate in the `After` hook; unquoted paths in Gherkin steps split on
spaces/commas — quote them; `{string} is true` vs `{string} is {string}` are
ambiguous — use distinct phrasing. Postgres must publish 5432 on 127.0.0.1
(compose does) for hub BDD.

Full incident log with root-cause narratives: [references/incidents.md](references/incidents.md).
