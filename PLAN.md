# Pi Autoresearch Lab — Implementation Plan

Tasklist derived from [DESIGN.md](DESIGN.md). Milestones are sequenced; tasks within a milestone are parallelizable unless noted. Each milestone ends with a **validation gate** (all runnable without GPU hardware except P4).

---

## M0 — Repo hygiene & skeleton
- [ ] `git init`, LICENSE, `.gitignore`, `README.md` quick-start (points to DESIGN/PLAN/demo)
- [ ] Repo layout scaffold:
  ```
  hub/            # supervisor (Node/TS), dashboard, extensions
  spoke/          # runner service
  protocols/      # job protocol + event schemas (versioned specs)
  examples/demo-project/
  docs/           # ADRs, decisions, runbooks
  ```
- [ ] `.env.example` with all hub secrets documented (API keys, HF token, git creds)

**Validation:** fresh clone reads coherently; no secrets in tree.

## M1 — Job protocol v0
- [ ] `protocols/job.yaml` schema: id, activity, image, command, worktree, requirements, inputs, outputs (evidence/artifacts/large), timeout
- [ ] Progress contract spec: `progress.jsonl` lines (`t, pct, eta_s, stage, metrics`), terminal states, heartbeat cadence
- [ ] Reference emitter library (tiny, dependency-free): `protocols/emit/{py,sh}` helpers any job can call
- [ ] Cancellation & lease semantics spec (poll interval, heartbeat timeout, re-queue rules)

**Validation:** demo job scripts emit schema-valid progress lines standalone — already true today:
`python examples/demo-project/jobs/simulate_training.py --variant baseline --steps 50 --out /tmp/run` produces `progress.jsonl` (t/pct/eta_s/stage/metrics + terminal `state`) and `metrics.json` evidence. M1 adds a formal schema checker (`protocols/ --validate <run-dir>`) and replaces inline emitters with `protocols/emit/{py,sh}` helpers.

## M2 — Hub core
- [ ] Postgres schema v1: `jobs`, `job_events` (append-only), `nodes`, `leases`, `activities`, `gates`, `approvals`, `agents`, `agent_events`, `artifacts`
- [ ] Hub HTTP API: `POST /jobs`, `GET /work?node=<id>` (pull, lease-granting), `POST /jobs/:id/status`, `POST /jobs/:id/events`, `DELETE /leases/:id` (cancel/relinquish)
- [ ] SSE fan-out: `GET /stream` (dashboard) with last-event-id resume
- [ ] Matching: job requirements vs node capability tags; lease capacity accounting
- [ ] Resilience: lease expiry → re-queue; idempotent event ingestion

**Validation:** integration test — submit 10 simulated jobs against 2 fake puller loops; assert completion, event ordering, lease re-queue on simulated node death.

## M3 — Spoke runner
- [ ] Runner service (long-poll work loop, execute container jobs, relay progress/events to hub)
- [ ] Worktree manager: checkout/update project repo worktrees per activity; cleanup policy
- [ ] Compose spoke profile (`runner` + optional `vllm`), capability tags via env (`NODE_TAGS=gpu:rtx5090,vram:32G`)
- [ ] Resource quota enforcement hooks (compose reservations/limits; GPU optional)

**Validation:** on one laptop/desktop (no GPU): hub compose + two spoke profiles (different tags) run demo jobs; dashboard stream shows live progress/ETA; kill a runner mid-job → lease expiry re-queue works.

## M4 — Planning graph & gates
- [ ] `plan/graph.yaml` schema: goal ref, activities (DAG edges, job specs/refs), exit gates (criteria, evidence pointers)
- [ ] Graph engine in supervisor: parse, validate DAG, freeze on approval, schedule ready activities as jobs
- [ ] Gate evaluation: criteria check orchestration; pass/fail records in Postgres
- [ ] Approval queue records: plan approval, substantial change, escalation, gate summary

**Validation:** demo graph loads; approvals block execution until acted on; failing a demo gate blocks downstream activities.

## M5 — Agent runtime (pi SDK)
- [ ] Supervisor hosts agent roles as pi SDK sessions in containers (worker first)
- [ ] Purpose-built extensions v0: job-protocol tools (submit job, read progress, read artifacts), repo tools (worktree-aware), event bridge (agent events → hub bus)
- [ ] **Community-package evaluation spike** (workstream): shortlist candidates (subagent orchestration, TUI observability), evaluate against job protocol + gates, adopt-or-skip memo in `docs/adr/`
- [ ] Auditor agent: gate verification flow (criteria + evidenced-claims checks)
- [ ] Director agent: plan drafting, assignment, escalation handling (second-opinion routing via tier registry)
- [ ] Model-tier registry + per-project `config/models.yaml` (role→tier→model); LiteLLM config generation

**Validation:** scripted demo run — director drafts plan → human approves → worker executes simulated jobs → auditor passes/fails gates → repair path exercised; all visible on the event stream.

## M6 — Dashboard: ops view
- [ ] Web app: job table (progress bars, ETA, stage), node health, activity feed (jobs + agents unified), SSE live updates
- [ ] Job detail: progress timeline, metrics, artifacts links (git/HF lineage)
- [ ] Minimal auth (token), single-user

**Validation:** operator watches the M5 scripted run live; no polling artifacts; reconnect resumes stream.

## M7 — Dashboard: approvals & gates UX
- [ ] Approval inbox: plan approvals (structured plan rendering), substantial changes, escalations, gate-audit summaries; approve/reject with comment
- [ ] Gate results view: criteria checklist, evidence links, auditor reasoning

**Validation:** full governance loop from the browser: approve plan → observe run → handle one forced escalation.

## M8 — Chat bridge
- [ ] Supervisor chat service: pi-session-backed conversations with any role; history in Postgres; context injection (current plan/job state)
- [ ] Dashboard chat panel

**Validation:** operator asks "why did gate 3 fail?" mid-run; the addressed role answers with correct job context.

## M9 — Reflector & librarian
- [ ] Reflector: aggregates retrospectives + audit anomalies → proposals (plan/skill changes) → director approval flow
- [ ] Librarian: artifact registry (git commit ↔ HF revision), taxonomy/indices of lessons, literature notes; indexing jobs via job protocol
- [ ] Skill-change pipeline: proposal → (optional) worktree A/B on identical inputs → commit on approval

**Validation:** inject a flawed skill demo → reflector proposes fix → A/B worktree run compares outcomes → approved commit lands in git.

## M10 — Packaging, demo polish, public release
- [ ] `docker-compose up` one-command hub bootstrap; spoke join via documented profile
- [ ] Demo project hardened as canonical quick-start (~1h, no GPU): walkthrough, expected outputs, troubleshooting
- [ ] README final pass; screenshots; LICENSE; CI (schema tests, integration smoke)
- [ ] Public release of framework repo

**Validation:** an outside collaborator (or fresh VM) completes the demo quick-start unaided in ≤1h.

## P4 (post-release) — Real compute
- [ ] First real GPU campaign on 5090 spoke (real training job via job protocol)
- [ ] DGX Spark joins as second spoke; quota profile validated under real inference+training contention
- [ ] LiteLLM against real local (vLLM) + remote models; tier config finalized for the first real project

---

## Dependency order

```
M0 → M1 → M2 → M3 → M4 → M5 → M6 → M7 → M8 → M9 → M10 → P4
                (M4 can start after M2; M5 spike after M3)
```

## Standing workstreams

- **Community package evaluation** (starts M5, ongoing): each candidate gets an adopt/skip memo in `docs/adr/`.
- **Skill library growth** (starts M9, ongoing): skills evolve with research; all changes through governance.
