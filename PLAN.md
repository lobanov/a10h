# Pi Autoresearch Lab — Implementation Plan

Tasklist derived from [DESIGN.md](DESIGN.md). Milestones are sequenced; tasks within a milestone are parallelizable unless noted. Each milestone ends with a **validation gate** (all runnable without GPU hardware except P4).

**Single timeline** — completed stages (M0–M6) are kept below as-built; all upcoming work is deduplicated into one sequence: **R1→R7 (git plane + worker-agent refinement), then M7→M10, then P4**.

| Order | Stage | Scope | Ordered here because |
|---|---|---|---|
| done | M0–M6 | protocols, job plane, worker, governance, agents (director/auditor), dashboard ops + approvals | as-built |
| 1–7 | R1 → R7 | gitserver+CA+tokens · task branches + pre-receive policy · checkout rework · SSE worker protocol · gates/auditor on committed state · secretary (work handoff) · demo seeding + validation rework | re-architects the core planes first so every later feature builds on final mechanics |
| 8 | M7 | approvals & gates UX polish (deduped against M6) | renders the final event model landed by R7 |
| 9 | M8 | chat bridge (pi sessions, dashboard panel) | context injection reads the final state model |
| 10 | M9 | reflector + skill-change pipeline (secretary scope lives in R6) | A/B runs go through the git plane |
| 11 | M10 | packaging, demo polish, public release | needs everything above stable |
| 12 | P4 | real compute (first GPU campaign, Spark joins) | post-release by definition |

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
- [x] Runner service (pull loop, host job workloads as **subprocesses inside the worker container** — no host docker socket; detached process groups with SIGKILL-tree cancel/timeout; relay progress/events; multi-file progress.jsonl discovery)
- [x] Worktree manager: clone/worktree strategies per activity; cleanup policy
- [x] Compose worker profile (`worker-a`/`worker-b`), capability tags via env (`NODE_TAGS`)
- [x] Resource quota hooks: compose reservations documented; workload env is minimal with explicit `JOB_ENV_*` passthrough; `image` field is advisory stack metadata matched via tags

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

---

## R-series — Git plane + worker-agent refinement (designed; supersedes parts of M2/M3/M5 mechanics)

Source: DESIGN.md v1.1 (§3.2.1 git plane, §3.3 state model, §3.4 skills, §4 deployment, §5.1 roster, §7.1 SSE protocol). Each milestone has hard acceptance criteria; all existing green suites must stay green unless explicitly reworked in R7.

### R1 — Gitserver + internal CA + worker tokens
- [ ] `gitserver` service in hub compose: nginx + git-http-backend (fcgiwrap), bare repos on `data/repos/*.git`, smart HTTP over TLS
- [ ] Bootstrap script: generate internal CA + gitserver server cert; create bare repos; issue worker git tokens; write hub-maintained policy map (job → allowed ref → token)
- [ ] CA cert + token distribution to workers (compose secrets/env); `http.sslCAInfo` wired in worker git config
- [ ] Hub-side git read access (supervisor reads bare repos directly for gates/auditor/secretary)

**Acceptance:** from a worker container, `git clone https://<token>@gitserver/demo.git` succeeds with CA trust; unauthenticated clone fails; TLS errors absent. Bootstrap is idempotent (re-run safe).

### R2 — Task branches + pre-receive policy
- [ ] Scheduler creates `refs/tasks/<activity>` at current main tip on promotion; job spec carries `{branch, base_sha}`
- [ ] Hub-generated pre-receive hook enforces: ref-match + token-match + fast-forward; denies pushes to any other ref incl. main
- [ ] One-time rebase/force authorization records (granted by hub, consumed by hook)
- [ ] Lease-expiry requeue appends on the same branch (no reset)
- [ ] Serialized per-repo landing queue in scheduler (ff-merge when descendant; else emit rebase instruction — R4)

**Acceptance (hub BDD):** push to wrong ref → rejected; push to task ref with wrong token → rejected; non-ff push without authorization → rejected; authorized rebase push → accepted once, replay rejected; after audit-complete, main ff-merges the branch; concurrent-landing fixture produces exactly one merge + one rebase instruction.

### R3 — In-container checkout rework
- [ ] Worker clones from gitserver (full clone, task branch) using CA + token; checks out `{branch, base_sha}`
- [ ] Delete worktree code path and `CHECKOUT_STRATEGY` env; remove `/repo` bind mount from worker services
- [ ] Checkout deleted on task end (exit-after-task makes the container itself ephemeral)

**Acceptance (worker BDD):** checkout scenario reworked — clone source is the gitserver URL fixture (fake hub/git server), correct branch checked out, workspace contains the branch content; no worktree/`/repo` references remain in worker code or compose.

### R4 — SSE worker-agent protocol + session model
- [ ] Registration endpoint (well-known URL): worker announces → hub issues session id (scoped to container lifetime)
- [ ] Per-session SSE endpoint with fresh buffer (no last-event-id); instruction buffering while no live session (restart window)
- [ ] Instruction event types: `work_offer`, `auditor_feedback`, `retrospective_prompt`, `repair`, `rebase` (carries target main SHA + force-window ref), extensible `custom`
- [ ] Register-then-offer replaces `GET /api/work` polling (remove or demote to bootstrap/fallback); worker→hub acks via API
- [ ] Worker hosts a Pi agent session; instructions arrive as turn inputs; exit-after-task + `restart: always` wired in compose

**Acceptance (worker BDD + integration):** session lifecycle scenario (register → receive instruction → ack → exit); reconnect-after-restart scenario delivers buffered instruction; e2e shows auditor feedback and retrospective prompt consumed as Pi turns; no polling loop remains.

### R5 — Auditor + gates on committed state
- [ ] Mechanical gate reads switch from Postgres blobs to bare-repo tree at task-branch tip (`git show`/archive read)
- [ ] Auditor agent prompt/tooling reads the same committed state (incl. post-rebase re-audit round before merge)
- [ ] Remove evidence-upload API + `artifacts` content column → lineage index (path ↔ commit ↔ HF revision)
- [ ] Remove `inputs_evidence` injection; dependents clone main (evidence via merged history)
- [ ] Churn-minimizing landing policy implemented (rebase only at landing turn; deferrable under high concurrency)

**Acceptance (hub BDD + e2e):** gate criteria evaluated against committed files; sabotage run fails on committed evidence; audited-complete merge lands exactly the audited SHA; rebase path triggers re-audit before merge; Postgres contains zero research content (schema + row audit).

### R6 — Secretary agent (work handoff)
- [ ] Secretary agent (hub-side pi session, small/mid tier): operationalizes director intent into worker-facing specifics — artifact paths/refs, retrospective/summarize/archival follow-up requests — delivered via R4 instruction events
- [ ] Retention execution: preserve branch + commit summary note to main for every attempt (success and failure)
- [ ] Lineage index maintenance (git ↔ HF pointers)
- [ ] Role-shaping skill authored framework-side (`skills/secretary/`)

**Acceptance (integration + e2e):** work_offer events carry secretary-authored operational details; every completed/failed attempt yields a note commit on main referencing the branch; the secretary never decides research direction (skill constraint test).

### R7 — Demo seeding + validation rework
- [ ] Bootstrap seeds `data/repos/demo.git` from `examples/demo-project`; framework repo no longer mounted to workers
- [ ] Migrate role-shaping skills (auditor/reflector/secretary) from `examples/demo-project/skills/` to framework `skills/`; demo project keeps only worker-task-specific skills
- [ ] e2e rework — new git-plane checks: task branch pre-created; push denied to wrong refs; audited-complete merge lands on main; failed repair preserved + summary note committed; rebase path exercised (concurrent fixture)
- [ ] Worker BDD: SSE-instruction + session-lifecycle scenarios; hub BDD: hook/merge scenarios (R2)
- [ ] Skill (`autoresearch-e2e`) + incidents log extended for the new stack (gitserver, CA, sessions, exit-after-task)
- [ ] Dashboard truth-aligned: branch/merge events in the activity feed; attempt notes visible

**Acceptance:** full e2e green on the deployed R-stack (all prior 20 checks reworked + new git-plane checks); both BDD suites green; demo quick-start (Part E) updated and passing; skill updated.

---

## M7 — Dashboard: approvals & gates UX polish
*M6 already shipped the live approval inbox, gate results view, and agent log; M7 keeps only the polish deltas. Ordered after R7, which finalizes the event model (branch/merge/attempt-note events) these views render.*

- [ ] Structured plan rendering inside approval cards (goal, activities, gates)
- [ ] Substantial-change cards and gate-audit summaries in the inbox
- [ ] Approve/reject/resolve **with comment**; evidence links + auditor reasoning surfaced from committed state (R5)
- [ ] Attempt-history browsing: preserved task branches + secretary summary notes (built on R7's feed events)

**Validation:** full governance loop from the browser on the R-stack: approve plan → watch run incl. one audited merge and one failed-repair note → resolve a forced escalation with comment.

## M8 — Chat bridge
*Ordered after the R-series: chat context injection reads the final state model (committed evidence, merged main). No hard dependency — can be pulled earlier in parallel if desired.*

- [ ] Supervisor chat service: pi-session-backed conversations with any role; history in Postgres; context injection (current plan/job state)
- [ ] Dashboard chat panel

**Validation:** operator asks "why did gate 3 fail?" mid-run; the addressed role answers with correct job context.

## M9 — Reflector & skill-change pipeline
*Secretary scope lives in R6 (work handoff, retention, lineage index). M9 keeps reflection and skill evolution.*

- [ ] Reflector: aggregates retrospectives + audit anomalies → proposals (plan/skill changes) → director approval flow
- [ ] Skill-change pipeline: proposal → optional **A/B on identical inputs** (branch-based: two task-style checkouts — worker worktrees were removed in R3) → commit on approval via the git plane

**Validation:** inject a flawed skill demo → reflector proposes fix → branch-based A/B run compares outcomes → approved commit lands in git.

## M10 — Packaging, demo polish, public release
- [ ] One-command `docker-compose up` verified on a fresh clone (reuses the R1 bootstrap: CA, bare repos, tokens, demo seeding); worker join via documented profile
- [ ] Demo project hardened as canonical quick-start (~1h, no GPU): walkthrough, expected outputs, troubleshooting (builds on R7's reworked quick-start)
- [ ] README final pass; screenshots; LICENSE; CI (schema tests, integration smoke)
- [ ] Public release of framework repo

**Validation:** an outside collaborator (or fresh VM) completes the demo quick-start unaided in ≤1h.

## P4 (post-release) — Real compute
- [ ] First real GPU campaign on 5090 worker (real training job via job protocol)
- [ ] DGX Spark joins as second worker; quota profile validated under real inference+training contention
- [ ] LiteLLM against real local (vLLM) + remote models; tier config finalized for the first real project

---

## Dependency order (single timeline)

```
Done:     M0 → M1 → M2 → M3 → M4 → M5 → M6
Upcoming: R1 → R2 → R3 → R4 → R5 → R6 → R7 → M7 → M8 → M9 → M10 → P4
```

- Within the R-series: R3 needs R1+R2; R4 can start after R2 (instruction schema needs task-branch concepts); R5 needs R3+R4 (rebase instructions); R6 needs R4+R5; R7 closes the series.
- M7–M9 have no hard R-dependency beyond what they consume (M7 renders R7's events; M8's context injection reads the final state model; M9's A/B uses the git plane) — M8 may run in parallel with M7/M9 if desired.
- M10 waits for everything above; P4 is post-release by definition.

## Standing workstreams

- **Community package evaluation** (started M5, ongoing): each candidate gets an adopt/skip memo in `docs/adr/`.
- **Skill library growth** (starts R6, ongoing): skills evolve with research; all changes through governance.
