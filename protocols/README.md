# Job Protocol v0

The contract every long-running job satisfies. **Stack-agnostic:** jobs never
import framework code; the framework only standardizes the interface below.

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

Jobs append JSON lines to `progress.jsonl` **in their working directory**
(checked out at `/workspace` inside the job container):

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

## 3. Evidence contract

- Files listed in `outputs.evidence` are uploaded to the hub with the job
  result and become the inputs to **gate evaluation** (mechanical checks) and
  **auditor review** (reasonableness). Evidence is reproducibility-bearing:
  seeds, config hashes, metric files.
- Large artifacts belong on HuggingFace (recorded in the project's artifact
  registry by the librarian); evidence files are small by design.

## 4. Lease & cancellation semantics

- Spokes **pull** work (`GET /api/work?node=<id>`); a granted job is leased
  with a TTL renewed by heartbeats/status/event posts.
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
