# Job Protocol v0

The contract every long-running job satisfies. **Stack-agnostic:** jobs never
import framework code; the framework only standardizes the interface below.

**Execution model (security):** workers host job workloads as **subprocesses
inside the worker container** — no host docker socket, no sibling containers.
A compromised workload is confined to the worker container and cannot reach
the host. Consequently the `image` field is **advisory**: it declares the
stack a job expects (e.g. `python:3.12-slim`); operators provision worker
images with the runtimes they serve and advertise them via `NODE_TAGS`
(e.g. `NODE_TAGS=python:3.12,cpu:8`), and job `requirements.tags` selects
workers carrying the right runtime.

## 1. Job spec (submitted to the hub)

```jsonc
{
  "id": "train-a1b2",              // hub-assigned (unique)
  "activity": "baseline",          // planning-graph activity (optional for ad hoc jobs)
  "plan_id": "demo-curriculum",    // planning-graph id (optional for ad hoc jobs)
  "image": "python:3.12-slim",     // any container image
  "command": ["python", "jobs/simulate_training.py", "..."],
  "requirements": { "gpu": false, "cpu": 1, "mem": "512M", "tags": [] },
  "outputs": {
    "evidence":  ["runs/baseline/metrics.json"],   // auditable, gate-checked
    "artifacts": ["runs/baseline/progress.jsonl"]  // retained outputs
  },
  "timeout_s": 600,
  "attempt": 1
}
```

Schema: [`job.schema.json`](job.schema.json)

## 2. Progress contract

Jobs append JSON lines to a `progress.jsonl` **in their output location** —
the working directory or any subdirectory (e.g. `runs/<variant>/progress.jsonl`).
The runner discovers and tails every `progress.jsonl` under the job workspace
(excluding `.git`), so multi-output jobs report from all of them:

```jsonc
{"t": 1.23, "pct": 42.0, "eta_s": 61.7, "stage": "step 84/200", "metrics": {"loss": 0.51}}
{"t": 3.45, "pct": 100.0, "eta_s": 0, "stage": "done", "metrics": {"loss": 0.20}, "state": "succeeded"}
```

- `t` seconds since job start; `pct` monotonic 0–100; `eta_s` best-effort
  seconds remaining; `stage` human-readable; `metrics` free-form scalar map.
- Terminal line carries `"state": "succeeded" | "failed"`.
- Jobs that cannot estimate progress emit stage transitions with `pct` held
  (consumers degrade gracefully).
- Exit code 0 iff terminal state is `succeeded`.

The runner tails this file and relays lines to the hub
(`POST /api/jobs/:id/events`), which stores and fans them out over SSE.

Schema: [`progress.schema.json`](progress.schema.json)

## 3. Evidence contract (R5: evidence IS committed state)

- Evidence files are **committed to the job's task branch** — never uploaded.
  The worker pushes its work to `refs/tasks/<plan>/<activity>` and reports
  the pushed commit SHA with its terminal status
  (`POST /api/jobs/:id/status` with `pushed_sha`).
- **Gate evaluation** (mechanical checks) and **secretary verification**
  read the declared `outputs.evidence` paths at exactly that SHA from the
  hub's bare repo — no tree-wide search, no Postgres blobs. A criterion's
  `file` resolves only against the declared list (a decoy file elsewhere in
  the tree cannot satisfy a gate).
- Upstream evidence reaches dependent activities through **merged main**
  (dependents' task branches are cut from main after their dependencies
  land) — there is no evidence materialization/injection.
- Large artifacts belong on HuggingFace (hub-side access; the secretary
  maintains the lineage index); evidence files are small by design.

## 4. Lease & cancellation semantics

- Workers **register** (`POST /api/nodes/register`) and receive work as SSE
  `work_offer` instructions on their session stream (`GET
  /api/worker-sessions/:id/events`); accepting an offer leases the job
  (`POST /api/worker-sessions/:id/ack` with `accept_offer`). `GET /api/work`
  is a demoted bootstrap/fallback. A leased job carries a TTL renewed by
  status/event posts.
- Lease expiry (runner death, network partition) → job re-queued with
  `attempt+1`, capped by the hub's retry policy; the demo exposes the requeue
  as a live SSE event.
- Cancellation is honored at the next lease/poll touch: the hub marks the job
  cancelled; the runner kills the job container at its next status exchange.

## 5. Helpers & validation

- [`emit/emit.py`](emit/emit.py), [`emit/emit.sh`](emit/emit.sh) — dependency-free
  progress emitters for job authors.
- [`validate.mjs`](validate.mjs) — validate a run directory against the
  schemas: `node protocols/validate.mjs <run-dir>` checks every
  `progress.jsonl` line and prints a report; exit 1 on violations.
