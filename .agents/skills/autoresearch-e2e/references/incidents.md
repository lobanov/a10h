# E2E incident log — root causes and proofs

Narrative record of real incidents hit while bringing the deployed stack to
green. Each entry: symptom → root cause → fix (all fixes are in the repo;
this file exists so the same debugging paths are never walked blind again).

## 1. Both workers wedged busy (the "stuck dashboard" incident)

- **Symptom:** plan approved, one job `queued`, zero leases, both workers
  `busy` forever; dashboard looked frozen.
- **Root cause:** `executeJob` set `busy = true`, then called `checkout()`
  *before* the `try` whose `finally` reset `busy`. A failing checkout (see #2)
  threw past the finally — `busy` leaked true and the pull loop never ran
  again, on both workers.
- **Fix:** whole body wrapped in `try/finally { busy = false }`; checkout
  inside. Lesson: **initialize-then-cleanup pairs must bracket the entire
  critical section, including fallible setup.**

## 2. Git "dubious ownership" on the mounted repo

- **Symptom:** `git clone /repo …` failed inside workers with
  `fatal: detected dubious ownership`.
- **Root cause:** host repo (uid 1002) mounted into containers running as
  root; git refuses. Attempted `-c safe.directory=*` — **git ignores that
  flag from `-c` deliberately** (security: untrusted repo config must not be
  able to whitelist itself).
- **Fix:** `git config --global --add safe.directory '*'` baked into
  `worker/Dockerfile`. Lesson: verify security-sensitive flags in the actual
  runtime, not from memory.

## 3. Container-name collision after lease requeue

- **Symptom:** killed worker mid-job; hub correctly requeued; the second
  worker's `docker run` failed instantly: `Conflict. The container name
  "/autoresearch-job-lease-demo" is already in use` (the dead worker's job
  container kept running — it was never the hub's to kill).
- **Fix:** names are now worker-unique (`ar-job-<worker>-<job>`) plus a
  best-effort `docker rm -f` of the worker's own stale name before run.
- **Lesson:** names shared across independent actors are a liveness coupling;
  namespace by owner.

## 4. Silent job requeued while alive (lease semantics gap)

- **Symptom:** `sleep 150` job: attempt 1 killed → attempt 2 leased by the
  other worker and *running*, yet the hub requeued it to attempt 3 ~40 s in.
- **Root cause (two bugs):** (a) leases renewed **only** on progress events —
  silent jobs never renewed; (b) `/status` with `state:"running"` set
  `lease_expires = NULL`, and `NULL` never expires… but also never renews
  against tick logic cleanly. Race produced the requeue.
- **Fix:** runner posts `running` + attempt every 10 s (lease renewal loop);
  hub renews `lease_expires` on running; all runner posts carry `attempt`, and
  the hub rejects stale-attempt writes with `409`.
- **Proof (kill-test, reproduce anytime):** submit `sleep 150` job → confirm
  lease → `docker kill` the leasing worker → watch
  `running|1|A → (lease expiry ~30 s) → leased|2|B → running|2|B` (renewals
  every 10 s) → `succeeded|2|B` at t+180 s. SSE shows `"requeued":true`.

## 5. vLLM cannot serve unsloth GGUF (three distinct errors)

- `OSError: … .gguf is not a valid JSON file` (speculators pre-step reads the
  GGUF path as a transformers config),
  `Unknown config format "gguf"` (`--config-format=gguf` doesn't exist),
  `Cannot find any model weights` in dir mode (wants safetensors),
  plus `AmbiguousGlobalPerLayerAttributeError` from transformers 5.x strictness.
- **Conclusion:** vLLM ≥0.27 has no GGUF path at all. GGUF → llama.cpp.
  `ghcr.io/ggml-org/llama.cpp:server-cuda` (arm64 manifest OK for GB10/DGX
  Spark) loads the 15.8 GB UD-Q4_K_M in ~32 s, ~4 slots at 8192 ctx.
- Also: the GGUF repo ships no tokenizer files; llama.cpp needs none.
- **Lesson:** match quant-ecosystem to server (unsloth GGUF ⇒ llama.cpp).

## 6. Compose string `command:` mangles quoted JSON

- `--hf-overrides {"allow_global_per_layer_attribute_access":true}` survived
  `docker compose config` validation but arrived at argparse without quotes →
  `ValueError … cannot be converted to loads`. YAML `>`-folded strings pass
  through shlex inside the image entrypoint.
- **Fix:** list-form `command:` entries (`- "--flag={\"k\":true}"`). Use list
  form for anything containing quotes/braces.

## 7. Agents ran but never called their tools

- **Symptom:** `agent_log: auditor no_tool_call` ×N; audit checks failed.
- **Root cause:** `createAgentSession({ tools: [], customTools: [t] })` — an
  empty `tools` allowlist excludes custom tools too (documented, but subtle).
- **Fix:** `noTools: "builtin"` keeps customTools, drops built-ins.

## 8. Six concurrent audits → all timed out

- **Symptom:** every `turn_error: agent timeout` (120 s) though a single
  probe audit completed in 24 s.
- **Root cause:** 6 gates completed near-simultaneously → 6 parallel turns
  against one provider (rate limits, queueing) → serialized latency
  explosion.
- **Fix:** per-role FIFO turn queues (`enqueue(role, …)`, 180 s timeout) in
  `hub/src/agents.ts`; E2E waits extended to minutes. Auditor on the local
  model serializes naturally and is the steady-state default
  (director = GLM-5.3 only, per policy).

## 9. Hub EADDRINUSE on restart (host dev)

- `kill $(cat hub.pid)` left the real listener alive: `npm start` → npm →
  npx → tsx → node chain; the PID captured was npm's.
- **Fix pattern:** `pkill -f "tsx src/index.ts"` (match the leaf), verify
  with `pgrep -fa`, then start. In compose this problem disappears
  (`docker compose up -d --build hub`).

## 10. BDD determinism lessons (cucumber)

- Hub scenarios share one scratch DB → `After` hook truncates all mutable
  tables, or jobs leak across scenarios (`'t-invalid' == 't-lease'`).
- Gherkin splits `When I GET /api/health` on spaces → quote path args.
- `{string} is true` collides with `{string} is {string}` → cucumber
  "ambiguous" — phrase distinct step texts.
- Assertion phrasing must target *stable* contracts: after a failed gate the
  activity may already be re-promoted to `running` (attempt 2) by the time you
  look — assert "failed verdict + second job exists", not a transient
  `repair` status.
- Postgres for hub BDD needs `127.0.0.1:5432` published (compose has it).

## 11. Docker socket removed — subprocess hosting (architecture change)

- **Threat:** workers mounted `/var/run/docker.sock` to launch job containers.
  The socket is root-equivalent on the host, and workers execute *untrusted*
  research code (pulled dependencies, experiment scripts) — a compromised
  worker/workload could escalate to full host control via the daemon.
- **Change:** workers now host workloads as **subprocesses inside the worker
  container** (detached process group, SIGKILL-tree on cancel/timeout, minimal
  env + explicit `JOB_ENV_*` passthrough). The socket mount is gone from
  compose; `docker.io` gone from the image.
- **Consequences:** `image` became an **advisory stack declaration** (matched
  via `NODE_TAGS` ↔ `requirements.tags`); worker images must carry the runtimes
  they serve (demo needs `python3` + `python-is-python3`); incidents 3
  (container-name collisions) and the uid-mapping cleanup lesson are
  **obsolete by design**.
- **Lesson:** never give code-execution services the host container socket;
  confine them to their own container and treat stack requests as scheduling
  metadata, not launch instructions.

## Verification recipes (copy-paste)

```bash
# stack health
docker compose --profile worker --profile local-llm ps --format '{{.Name}} {{.Status}}'
curl -s localhost:8080/api/health

# governance state snapshot
curl -s localhost:8080/api/state | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const s=JSON.parse(d);console.log(JSON.stringify({plans:s.plans,acts:s.activities,approvals:s.approvals.length,agents:s.agent_log.slice(0,3)},null,1))})"

# live SSE capture (proof of event flow)
curl -sN localhost:8080/api/stream > /tmp/sse.log &   # then: grep -c 'job_event' /tmp/sse.log

# clean re-run
docker exec autoresearch-postgres-1 psql -U autoresearch -d autoresearch -c "TRUNCATE nodes, jobs, job_events, artifacts, plans, activities, gate_results, approvals, agent_log;"
nohup node scripts/e2e-demo.mjs http://localhost:8080 > /tmp/e2e.log 2>&1 &
```

## R-series incidents (R1-R7 bring-up)

### R-series 1. Progress-tailer re-pumped committed attempt history (R4 wedge)

Symptom: workers hung forever after `task-branch push pushed`; jobs burned
attempts; job_events flooded (8k+ events for one job). Root cause: task
branches APPEND attempts, so every checkout carries committed
progress.jsonl files from earlier runs — the tailer re-pumped them all,
and the event flood starved the terminal status POST behind the worker's
fetch pool. Fix: baseline-snapshot tailer (only growth beyond the
pre-workload snapshot is this job's progress). Lesson: append-only task
branches make every committed artifact "live" in future checkouts —
collection/relay code must diff against the checkout baseline.

### R-series 2. Exit signaling deadlocks (three shapes)

(a) attempt-closure exits re-emitted every tick killed restarted workers in
a loop (fix: one-shot `exit_signaled_at`); (b) one-shot exits never reached
the generation that served a retry (fix: generation-release sweeper — busy
sessions with no pending work for their node exit and restart); (c) refusal
acks didn't revert the offered job (fix: refuse_offer → revert + release).
Lesson: per-container generations + per-activity outcomes need an explicit
reconciliation pass every tick.

### R-series 3. Everything-on-main churn (notes vs landings)

Retention notes moved main under in-flight verified branches → rebase →
re-verify → re-audit loops, burning rebase-round caps. Fixes: merged
attempts note inside the landing path before the exit; failed attempts
defer notes while the repo has pending landings (quiescent batching);
hub-side mechanical rebase with CAS for dead-worker divergence. Lesson:
any writer that moves main (notes, syncs) must coordinate with the landing
queue or it multiplies rebase churn.

### R-series 4. Import-hoisting breaks lazy env config

Test step files that top-level-import hub modules pull gitsvc in before
BeforeAll sets REPOS_DIR/POLICY_PATH (module-level consts captured
container defaults). Fix: lazy per-call env resolution. Lesson: any env
read at module load is a BDD trap — resolve at call time.

### R-series 5. Local-path pushes run the hook; fetches do not

Secretary notes push to main → pre-receive DENIES (by design). Fix: temp
clone commits the note, the bare FETCHES it (fetch runs no receive-side
hooks), then update-ref under the repo lock (with a CAS in hubRebase so
grace-window worker pushes are never overwritten).
