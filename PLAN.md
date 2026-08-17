# Pi Autoresearch Lab — Implementation Plan

Tasklist derived from [DESIGN.md](DESIGN.md). Milestones are sequenced; tasks within a milestone are parallelizable unless noted. Each milestone ends with a **validation gate** (all runnable without GPU hardware except P4).

**Single timeline** — completed stages (M0–M6) are kept below as-built; all upcoming work is deduplicated into one sequence: **R1→R7 (git plane + worker-agent refinement), then M7→M10, then P4**.

| Order | Stage | Scope | Ordered here because |
|---|---|---|---|
| done | M0–M6 | protocols, job plane, worker, governance, agents (director/auditor), dashboard ops + approvals | as-built |
| 1–7 | R1 → R7 | gitserver+CA+tokens · task branches + pre-receive policy · checkout rework · SSE worker protocol · gate verification on committed state · secretary (handoff + verification) · demo seeding + validation rework | re-architects the core planes first so every later feature builds on final mechanics |
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

Source: DESIGN.md v1.1 (§3.2.1 git plane, §3.3 state model, §3.4 skills, §4 deployment, §5.1 roster, §7.1 SSE protocol). Each milestone has hard acceptance criteria; existing suites stay green **per milestone** (fixtures are updated within the milestone that changes the behavior) — R7 reworks only the e2e.

### R1 — Gitserver + internal CA + worker tokens
- [x] `gitserver` service in hub compose: nginx + git-http-backend (fcgiwrap), bare repos on `data/repos/*.git`, smart HTTP over TLS
- [x] hf artifact store: shared `/hf-store` path (hub-side ownership; workers hold no tokens) — validated in demo mode; the real-bucket `hf-mount` sidecar image awaits an operator-provided HF bucket (pending operator input, tracked for final audit)
- [x] Bootstrap script: generate internal CA + gitserver server cert; create bare repos; issue worker git tokens; wire each project repo's **GitHub remote** (deploy key/PAT in hub `.env`) for upstream sync; write hub-maintained policy map (job → allowed ref → token)
- [x] CA cert + token distribution to workers (compose read-only mounts); `GIT_SSL_CAINFO`/`NODE_EXTRA_CA_CERTS` wired in worker env
- [x] Hub HTTP API served under the same internal CA (worker→hub registration/status/acks ride TLS, not just git)
- [x] Hub-side git read access (supervisor reads bare repos directly for gates/secretary — gitsvc.ts, upstream sync + ff through the serialized per-repo writer)

**Acceptance:** ✅ validated green — `node scripts/e2e-gitplane.mjs` (17 checks: bootstrap idempotent; TLS health; unauth clone fails; authed clone with CA; main-push denied; refs/tasks/* accepted; task ref in bare repo; hf-store write/read cross-worker, no HF token; upstream ff-sync + idempotent re-sync). Hub+worker BDD and `e2e-demo` stay green over TLS.

### R2 — Task branches + pre-receive policy
- [x] Scheduler creates `refs/tasks/<activity>` at current main tip on promotion; job spec carries `{branch, base_sha}` (repair re-promotions reuse the ref — attempts append)
- [x] Hub-generated pre-receive hook enforces: ref-match (active job bound to the branch) + token-match (leased jobs accept only their node's token) + fast-forward (creation pushes denied — hub pre-creates); denies pushes to any other ref incl. main (the operator write path flows through the GitHub remote + hub sync, never direct gitserver pushes); the hook is thin — it calls a supervisor API that validates pushes and **atomically consumes** one-time authorizations (FOR UPDATE SKIP LOCKED); ref deletions and tag pushes denied outright. Pushed-object quarantine dirs are forwarded so the hub-side git resolves new SHAs during pre-receive
- [x] One-time rebase/force authorization records (granted by hub at landing turn, consumed by hook, unconsumed grants expire)
- [x] Lease-expiry requeue appends on the same branch (no reset — branch rides on the job row)
- [x] Serialized per-repo landing queue in scheduler (ff-merge when descendant; non-ff branches **held** — rebase-instruction delivery arrives with R4; a stalled branch re-issues instruction + grant after the stall timeout)

**Acceptance:** ✅ hub BDD `git-plane.feature` (9 scenarios: branch pre-created with {branch, base_sha}; unassigned ref rejected; non-task ref rejected; foreign-node token rejected; ff by leasing node accepted; non-ff without authorization rejected; authorized rebase accepted once + replay rejected; verified-complete ff-merge to main; concurrent landing → exactly one merge + one held rebase instruction + grant). Deployed-stack integration via `e2e-gitplane.mjs` R2 section (real pushes through gitserver: unassigned rejected, assigned ff accepted, non-ff rejected, granted accepted, grant-consumed replay rejected). Hub+worker BDD and `e2e-demo` stay green.

### R3 — In-container checkout rework
- [x] Worker clones from gitserver (full clone, task branch) using CA + token; checks out `{branch, base_sha}` (fetch + checkout of `refs/tasks/<activity>`; jobs without a branch are rejected)
- [x] Delete worktree code path and `CHECKOUT_STRATEGY` env; remove `/repo` bind mount + `REPO_PATH` from worker services (compose, runner, .env.example)
- [x] Checkout deleted on task end (runner finally-block; exit-after-task makes the container itself ephemeral)
- [x] Work products committed and pushed to the task branch after the workload (attempts append — partial dead work stays visible); `HF_STORE_PATH` in worker env for per-task artifact subfolders (pointer commits via the same push)

**Acceptance:** ✅ worker BDD (9 scenarios — checkout from gitserver-URL fixture at the task branch, branch-content tracked, commit+push advances the origin branch, branchless jobs rejected; no worktree/`CHECKOUT_STRATEGY`/`/repo` references remain in worker code or compose). Deployed: `e2e-demo` ALL CHECKS PASSED with workers cloning/pushing through the real gitserver — task branches visible in the bare repo, worker result commits appended, and the verified-complete baseline branch ff-merged to main by the landing queue.

### R4 — SSE worker-agent protocol + session model
- [x] Registration endpoint (well-known URL): worker announces → hub issues session id (scoped to container lifetime); workers are uniform until registered
- [x] Per-session SSE endpoint with fresh buffer (no last-event-id); at-least-once redelivery of the full unacked buffer on every reconnect; idempotent acks; bounded per-session buffer (100); SSE keepalive closes dead sessions so workers re-register; live-connection tracking (`streaming`) excludes zombie sessions from offers
- [x] Instruction event types: `work_offer` (fresh-spec accept handshake — the ack returns the CURRENT job spec so the worker executes against fresh state), `gate_feedback` (verification findings, consumed as agent turn input; repair routing = gate_feedback + re-offer on the same branch), `retrospective_prompt` (canned template until R6; committed to the task branch as retrospective.md), `rebase` (target main SHA + one-time force grant; rebase+force-push server-authorized), `cancel` (hub-initiated stop emitted by the cancel endpoint, complements lease-expiry requeue), `exit` (post-merge / attempt-closed / no-pending-work), extensible `custom`
- [x] Register-then-offer replaces polling (GET /api/work demoted to bootstrap/fallback; workers never call it — asserted in BDD); worker→hub acks via API; offers expire after 30s and re-offer to another generation
- [x] Worker agentization: instructions arrive as Pi-session turn inputs (WORKER_MODEL; deterministic dispatch with turn logging when unset — validated in both modes); the M3 runner remains the executor (checkout/workload/push/rebase); per-instruction error isolation (a failing handler never kills the SSE loop)
- [x] No-rescue requeue: mid-task worker death → lease expiry → fresh attempt on the same branch (no state recovery); stuck-busy sessions released on lease/offer expiry
- [x] Exit only on the hub's signal, deferred until idle; one-task-per-container enforced on BOTH sides (completed workers refuse offers; idle-only offering); generation-release sweeper exits busy sessions whose node has no pending work (self-heals post-merge/attempt-closure/retry-generation cases); `restart: always` recreates the container
- [x] Wedge root-caused and fixed: the progress tailer re-pumped COMMITTED progress.jsonl files from earlier attempts (attempts append on the same branch) — thousands of stale event POSTs starved the terminal status POST behind the fetch pool. Fix: baseline-snapshot tailer (only content beyond the pre-workload snapshot is this job's progress) + line-boundary artifact capping + demo writes a fresh stream per run

**Acceptance:** ✅ worker BDD 12/12 (session lifecycle: register → offer ack-with-accept → gate_feedback turn → deferred exit; at-least-once redelivery on reconnect; zero work-poll requests); hub BDD 17/17; e2e-gitplane 20/20; deployed e2e ALL CHECKS PASSED on the full R-stack (SSE offers → clone → work → push → gate → audit → verified-complete merge to main → exit → restart → next task; retrospective.md committed; gate feedback + escalation with director note).

**Independent review (glm-5.3, post-build):** 10 major / 7 minor findings — 9 majors + 4 minors fixed and re-validated (zombie-offer black hole → refusal reverts job + releases generation; verified-complete join now latest-gate-result-with-pass; rebase `--onto` bug that dropped task commits; offer/session identity binding (no double-lease); plan-scoped task refs `refs/tasks/<plan>/<activity>`; INTERNAL_TOKEN guards main-advancing endpoints + worker API bearer auth + least-privilege mounts (CA cert + own token only); cancel SSE emission + lease-renewal cancel for silent jobs; post-terminal push grace window (retrospectives can land); per-activity promotion isolation; no-ack-on-failed-rebase; event-post node ownership; token redaction in logs). Deferred (documented): emitInstruction error-conflation (m5), rebase_instructions bookkeeping cleanup (m6), quarantine-path coupling note (m7), per-worker credential model beyond the shared operator token (single-operator v1 posture).

### R5 — Gate verification on committed state
- [x] Mechanical gates read the reported commit SHA from the bare repo (`readEvidenceAt`: declared `outputs.evidence` paths only — no tree-wide search; decoy files cannot satisfy criteria); terminal status carries `pushed_sha`
- [x] Gate-verification agent work reads the same committed state; `gate_results.evaluated_sha` pins the verified SHA — landing merges EXACTLY the verified tip, and a rebased/appended tip re-enters gate+audit verification before merging (re-verification round)
- [x] Evidence-upload API removed; `artifacts` table is a lineage index (path ↔ commit; no content column); lineage covers declared evidence AND artifacts (existence-checked at the SHA)
- [x] `inputs_evidence` injection removed (column dropped; dependents' task branches are cut from main only after dependencies' audited merges land — merged-main gating)
- [x] Churn-minimizing landing: ff-first; non-descendant tips emit a rebase instruction once per stall window with a one-time force grant; verification re-runs at the new tip
- [x] protocols/README.md §3/§4 + job.schema.json revised to the v1.1 contract (evidence = committed state + `pushed_sha`; register-then-offer; `/api/work` demoted)
- [x] e2e-demo reads artifacts via the lineage index + `git show` at commit_sha (content never round-trips through Postgres)

**Acceptance:** ✅ criteria evaluated against committed files at the reported SHA (hub BDD 17/17 — fixture commits evidence to the task branch and reports the SHA; sabotage/decoy paths structurally excluded by declared-paths-only resolution); verified-complete merge lands exactly the verified SHA (SHA-pinned landing + re-verification on tip change); dependents promote only on merged main; Postgres row audit green (e2e-gitplane 23/23: `artifacts.content` and `jobs.inputs_evidence` columns gone, lineage rows reference commits); worker BDD 12/12; deployed e2e ALL CHECKS PASSED (gate → audit → merge → dependent promotion on merged main → analysis passes → plan done, ~2 min).

### R6 — Secretary agent (work handoff, gate verification, retention)
- [x] Secretary agent (hub-side pi session, mid tier via SECRETARY_MODEL, AUDITOR_MODEL honored as legacy): work handoff — every work_offer carries secretary-authored operational details (branch/base SHA, artifact paths, follow-up requests, constraints) delivered via R4 instruction events
- [x] **Absorbed gate verification** (v1 "auditor" role retired): formal submission checks on committed state (queueVerification, secretary role); adversarial research review stays out of the framework; the audit VERDICT gates merges (dispute escalates, never merges); agents-disabled fallback = mechanical verification alone
- [x] Retention execution: every closed attempt (merged or failed/resolved/escalated) gets a summary note committed to main (notes/<plan>/<activity>/attempt-N.md, referencing the preserved branch) through the serialized per-repo writer (fetch + ff update-ref — no transport hooks); once per attempt
- [x] Landing convergence: worker rebase instructions remain the fast path; hub-side mechanical rebase (file-disjoint; conflict → stall/escalation path) converges divergence when the worker generation is gone (incl. note-induced main moves); stall window 120s (env-tunable); rebase rounds capped then operator escalation
- [x] Role-shaping skill authored framework-side (`skills/secretary/SKILL.md`: handoff + formal verification + retention + lineage + exit signal; never decides research direction, never performs adversarial review)
- [x] Lazy env resolution in gitsvc (REPOS_DIR/POLICY_PATH read per call — import-hoisting safe); worker exit signals: post-merge, attempt-closure, no-pending-work sweeper, generation_done on refusal

**Acceptance:** ✅ hub BDD 21/21 (secretary.feature: work_offer carries handoff with branch/artifact paths + constraints; verification recorded under the secretary role; merged attempt gets a note on main referencing the task branch; skill hard-constraints verified). Deployed e2e ALL CHECKS PASSED (~5 min: handoffs on every offer, secretary verification verdicts gating merges, attempt notes on main for merged and failed attempts, repair-demo escalation + resolution). Worker BDD 12/12; e2e-gitplane 23/23.

**Independent review (glm-5.3, post-build):** 6 major / 11 minor — all 6 majors + m1/m2/m6/m7/m8/m10 fixed and re-validated (audit-wedge sweep + bounded retries with mechanical fallback at 3; hubRebase CAS so worker pushes are never overwritten; rebase-round cap counts only recent held rounds; retention notes batched into quiescent windows — merged attempts note inside the landing path BEFORE the exit signal, failures defer while landings are pending; activity-id charset validated at graph parse AND at ref/path construction; authoritative note dedup + bounded retries with a stalled event; agents.ts header + env docs truth-aligned; graph intent (title/expected_outcome) wired into handoffs; LANDING_STALL lazy). Deferred (documented): m3 gate-eval idempotency per job+sha, m4 grace-window node snapshot, m5 post-hub-rebase retro ordering (self-healing via fresh checkout), m9 resolution disposition in notes, m11 extra BDD scenarios (hub-rebase fallback, failed-attempt note — covered by deployed e2e).

### R7 — Demo seeding + validation rework
- [x] Bootstrap seeds `data/repos/demo.git` from `examples/demo-project` (bootstrap-git.sh seed_repo); framework repo no longer mounted to workers
- [x] Demo project carries only the task-specific worker skill (`skills/demo/`); role-shaping skills removed from project repos
- [x] Framework-side role-shaping skills authored: `skills/secretary/` (R6), `skills/reflector/` (R7) — hub-side personas never live in project repos
- [x] e2e rework — new git-plane checks in `e2e-demo.mjs`: task branches pre-created under the plan scope; worker-token push to main DENIED by the deployed pre-receive hook (in-stack check via the gitserver container, CA-configured — policy denial, not a network artifact); verified-complete branches merged to main (all four successful activities' tips contained in main — serialized landing + the rebase path exercised every run since notes move main); failed repair branch PRESERVED; attempt notes on main (≥4, incl. the failed attempt)
- [x] Worker BDD: SSE-instruction + session-lifecycle scenarios (worker-sessions.feature, R4); hub BDD: hook/merge scenarios (git-plane.feature, R2) + secretary scenarios (secretary.feature, R6)
- [x] Skill (`autoresearch-e2e`) + incidents log extended for the R-stack (git-plane-first configure section; TLS clients; five R-series incidents: tailer re-pump wedge, exit-signal deadlocks, main-churn vs landings, import-hoisting env traps, hooks-vs-fetch transport rules)
- [x] Git-plane event taxonomy defined and emitted (branch_created, merged, note_committed, rebase_required, hub_rebase, upstream_sync); dashboard renders it in the activity feed (+ instruction/worker_session events); verification notes labeled secretary; attempt notes visible as git events
- [x] Demo quick-start (Part E) updated: bootstrap-git.sh step, TLS dashboard, https e2e with NODE_EXTRA_CA_CERTS, SECRETARY_MODEL fallback wording, post-run `git log` pointer

**Acceptance:** ✅ full e2e green on the deployed R-stack — `e2e-demo.mjs` ALL CHECKS PASSED including the six new git-plane checks; hub BDD 21/21 (100+ steps); worker BDD 12/12; `e2e-gitplane.mjs` 23/23; demo quick-start (Part E) updated and exercised; skill + incidents extended.

---

## M7 — Dashboard: approvals & gates UX polish
*M6 already shipped the live approval inbox, gate results view, and agent log; M7 keeps only the polish deltas. Ordered after R7, which finalizes the event model (branch/merge/attempt-note events) these views render.*

- [ ] Structured plan rendering inside approval cards (goal, activities, gates)
- [ ] Substantial-change cards and gate-verification summaries in the inbox
- [ ] Approve/reject/resolve **with comment**; evidence links + verification reasoning surfaced from committed state (R5)
- [ ] Attempt-history browsing: preserved task branches + secretary summary notes (built on R7's feed events)

**Validation:** full governance loop from the browser on the R-stack: approve plan → watch run incl. one verified merge and one failed-repair note → resolve a forced escalation with comment.

## M8 — Chat bridge
*Ordered after the R-series: chat context injection reads the final state model (committed evidence, merged main). No hard dependency — can be pulled earlier in parallel if desired.*

- [ ] Supervisor chat service: pi-session-backed conversations with any role; history in Postgres; context injection (current plan/job state)
- [ ] Dashboard chat panel

**Validation:** operator asks "why did gate 3 fail?" mid-run; the addressed role answers with correct job context.

## M9 — Reflector & skill-change pipeline
*Secretary scope lives in R6 (work handoff, retention, lineage index). M9 keeps reflection and skill evolution.*

- [ ] Reflector: aggregates retrospectives + verification anomalies → proposals (plan/skill changes) → director approval flow
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
