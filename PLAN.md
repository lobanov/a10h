# Pi Autoresearch Lab — Implementation Plan

Tasklist derived from [DESIGN.md](DESIGN.md). Milestones are sequenced; tasks within a milestone are parallelizable unless noted. Each milestone ends with a **validation gate** (all runnable without GPU hardware except P4).

---

## M0 — Repo hygiene & skeleton
- [x] `git init`, LICENSE, `.gitignore`, `README.md` quick-start (points to DESIGN/PLAN/demo)
- [x] Repo layout scaffold (hub/ worker/ protocols/ examples/ docs/ scripts/)
- [x] `.env.example` with all hub secrets documented (API keys, HF token, git creds)

**Validation:** fresh clone reads coherently; no secrets in tree. ✅ (secrets only in gitignored .env)

## M1 — Job protocol v0
- [x] `protocols/job.schema.json` schema
- [x] Progress contract spec: `progress.jsonl` lines (`t, pct, eta_s, stage, metrics`), terminal states, heartbeat cadence (protocols/README.md)
- [x] Reference emitter library: `protocols/emit/{py,sh}`
- [x] Cancellation & lease semantics spec (lease TTL 30s, heartbeat renewal, requeue ≤3 attempts; hub/src/scheduler.ts)
- [x] Validator: `protocols/validate.mjs` (progress + evidence + job specs)

**Validation:** demo job scripts emit schema-valid progress lines standalone — ✅ verified (happy, sabotage, malformed, emitters py+sh).

## M2 — Hub core
- [x] Postgres schema v1 (hub/src/schema.sql)
- [x] Hub HTTP API: jobs, work pull (lease-granting), status, events, result upload, cancel, artifacts readback (hub/src/api.ts)
- [x] SSE fan-out: `GET /api/stream` with ring-buffer replay (Last-Event-ID/`since`)
- [x] Matching: job requirements vs node capability tags; lease capacity accounting
- [x] Resilience: lease expiry → re-queue (≤3 attempts); idempotent event ingestion

**Validation:** ✅ covered end-to-end by scripts/e2e-demo.mjs against the deployed stack (2 fake pullers = compose runner-a/runner-b).

## M3 — Worker runner
- [x] Runner service (pull loop, execute container jobs, relay progress/events; multi-file progress.jsonl discovery)
- [x] Worktree manager: clone/worktree strategies per activity; cleanup policy
- [x] Compose worker profile (`worker-a`/`worker-b`), capability tags via env (`NODE_TAGS`)
- [x] Resource quota hooks: GPU/memory reservations documented in compose; job containers run as runner uid

**Validation:** ✅ two compose workers execute demo jobs; runner kill/requeue verified in E2E lease test (host dev run).

## M4 — Planning graph & gates
- [x] `plan/graph.yaml` schema: goal ref, activities (DAG edges, job specs/refs), exit gates (criteria, evidence pointers)
- [x] Graph engine: parse, validate DAG + cycles, freeze on approval, schedule ready activities (hub/src/plans.ts, scheduler.ts)
- [x] Gate evaluation: mechanical criteria (job_state, evidence_exists/json/fields, agent-deferred); pass/fail records
- [x] Approval queue records: plan approval, escalation; blocking until resolved
- [x] Cross-activity evidence flow: upstream evidence (transitive closure) materialized into dependent job checkouts

**Validation:** ✅ demo graph loads; approvals block execution; failing demo gate blocks downstream + escalates after repair.

## M5 — Agent runtime (pi SDK)
- [x] Supervisor hosts agent roles as pi SDK sessions (auditor, director)
- [x] Purpose-built agent tools: `record_audit` / `record_director_note` custom tools (defineTool)
- [x] Model plumbing: models.json generated from env (z.ai remote + local vLLM), serialized per-role turn queues
- [x] Auditor agent: gate verification flow (criteria + evidenced-claims checks → audit_note on gate_results)
- [x] Director agent: escalation recommendations (approve/retry/revise/escalate_human → agent_note on approvals)
- [x] Model-tier registry + per-project `config/project.yaml` (role→tier→model); LiteLLM config generation (litellm/config.yaml, optional profile)
- [ ] **Community-package evaluation spike** (workstream): shortlist candidates, evaluate, adopt-or-skip memo in `docs/adr/` — deliberately deferred; the purpose-built runtime covers v1 needs

**Validation:** ✅ auditor reviews every gate result (local gemma via vLLM); director attaches escalation recommendations (GLM-5.3).

## M6 — Dashboard: ops view
- [x] Web app: job table (progress bars, ETA, stage), node health, activity feed (jobs + agents unified), SSE live updates with reconnect
- [x] Approvals: plan approvals + escalations with approve/reject/resolve actions (operator UX)
- [x] Gate results view: criteria checklist, evidence reason, auditor notes
- [x] Agent log view; minimal auth (token), single-user

**Validation:** ✅ operator watches the E2E run live at http://localhost:8080; SSE resumes via since/Last-Event-ID (ring-buffer replay).

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
- [ ] `docker-compose up` one-command hub bootstrap; worker join via documented profile
- [ ] Demo project hardened as canonical quick-start (~1h, no GPU): walkthrough, expected outputs, troubleshooting
- [ ] README final pass; screenshots; LICENSE; CI (schema tests, integration smoke)
- [ ] Public release of framework repo

**Validation:** an outside collaborator (or fresh VM) completes the demo quick-start unaided in ≤1h.

## P4 (post-release) — Real compute
- [ ] First real GPU campaign on 5090 worker (real training job via job protocol)
- [ ] DGX Spark joins as second worker; quota profile validated under real inference+training contention
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
