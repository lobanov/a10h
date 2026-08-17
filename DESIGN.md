# Pi Autoresearch Lab — Design Doc

**Status:** v1.1 — implemented alpha + refinement design (R-series, see PLAN.md). Live: job plane, governance plane, director/auditor agents, dashboard ops+approvals, subprocess workloads. Designed (R1–R7): hub-served git plane with task branches + audited-complete merges, SSE worker-agent instruction protocol, exit-after-task workers, the secretary work-handoff role. This document records **decisions and architecture**; operational and protocol detail lives in [`protocols/README.md`](protocols/README.md) and the `.agents/skills/autoresearch-e2e/` skill.
**Repo role:** This is the *framework repo* — the multi-agent system itself. Research content lives in separate project repos (served by the hub's gitserver; see §3.2.1 Git plane).

---

## 1. Purpose

A multi-agent system (MAS) that operates a research lab for **experimental research on AI model architectures**. The MAS is **infrastructure, not the subject**: it plans, runs, audits, and reflects on real experiments (training small models, evals, sweeps, analysis) across local GPUs and remote APIs, while a single human operator supervises through a web dashboard.

### Requirements → architecture map

| # | Requirement | Where it lands |
|---|---|---|
| 1 | Durable artifacts in git | Two-repo model; project repo is the artifact store (git for code/text/metrics; HuggingFace Hub for large artifacts) |
| 2 | Visual web dashboard reflecting progress | Dashboard v1: ops view (job progress/ETA + agent activity) via SSE from hub |
| 3 | Reflective learning & audit workflows | Exit-gate audits, worker retrospectives, reflector agent, director approval ladder |
| 4 | Ad hoc chat about ongoing work | Dashboard chat, backed by pi sessions (planned — M8) |
| 5 | Hybrid inference (RTX 5090, DGX Spark, remote APIs) | OpenAI-style provider endpoints (remote or local; optional LiteLLM profile) + per-project role→model config; compose resource quotas on shared nodes |
| 6 | Agent hierarchy (director, workers, auditor, secretary) | pi SDK sessions in containers; roster in §5 |
| 7 | docker-compose deployment | Framework repo bootstraps via `docker-compose up`; workers join by running their compose profile (implemented) |
| 8 | Standard job protocol w/ progress/ETA; observable agentic work | Stack-agnostic job protocol (§6); all events land in hub Postgres and stream to the dashboard |
| 9 | Planning graph with gates, reviewed before execution | Planning graph + gate lifecycle (§5.3); human approves goal/first plan/substantial changes |

### Non-goals (v1)

- **Not multi-tenant.** Single operator; dashboard uses LAN/token auth. Authz seams are kept so a team can be added later without re-architecting.
- **No visual graph editor.** Planning graphs are files in the project repo; the dashboard renders them read-only inside approval forms. DAG visualization is deferred.
- **No reference ML stack.** The framework ships protocols, layout conventions, and Pi — never PyTorch/Harness opinions. Project stacks are arbitrary containerized guests.
- **Not autonomous goal-setting.** Humans own the goal; the director owns the plan within it.
- **No synchronous agent-to-agent chatter.** All coordination flows through the hub (jobs, events, approvals) so everything is observable and auditable.

---

## 2. System overview

```
                        ┌─────────────────────────── HUB (docker-compose) ────────────────────────────────┐
                        │                                                                                 │
  operator ──browser──► │  Dashboard (web UI: ops view + approval inbox [chat: M8])                          │
                        │     │  SSE                    │ REST                     ▲ pi sessions     │
                        │     ▼                         ▼                          │ (chat bridge)    │
                        │  Event bus ◄──────────── Supervisor (Node/TS) ────────────┘                       │
                        │     │                        │  agent roles as pi SDK sessions:                 │
                        │     ▼                        │   director · auditor (live)                      │
                        │  Postgres (lightweight       │   secretary (R6) · reflector (M9)                │
                        │  state + lineage index)      │                                                 │
                        │                              │                                                 │
                        │  LLM providers ◄────────────┘ remote APIs or local llama.cpp/vLLM               │
                        │                                                                                 │
                        │  Gitserver (nginx + git-http-backend): bare repos on data/repos/*.git          │
                        │    HTTPS (internal CA) · smart HTTP · worker tokens · pre-receive policy        │
                        │  hf-mount sidecar: HF Buckets as NFS — workers write artifacts, no HF tokens    │
                        └──────┬─────────▲──────────────┬──────────────────────────────▲────────────────┘
        clone/fetch/push task  │         │ push task     │ SSE instructions (register→  │ API: status,
        branch (git over TLS)  │         │ branch only   │ session id → per-session     │ progress, acks
                    ┌──────────▼─────────┴──┐       ┌───▼───────────────────┐         │
                    │ WORKER (one task per  │◄──────┘ per-container SSE    │◄────────┘
                    │ container; alive till │         endpoint, idle-waits │
                    │ merge — exits on the  │                                   │
                    │ secretary's signal)   │                                   │
                    │ Pi agent + workloads  │        [same shape on every node:  │
                    │ as subprocesses       │         5090 host / DGX Spark /   │
                    │ in-container checkout │         future nodes]             │
                    └───────────────────────┘                                   │
```

**Two rules make the topology simple:** workers never accept inbound connections and never touch Postgres — they *pull* work/instructions from the hub (HTTP + SSE initiated outbound) and push content as git to the hub's gitserver. **Git + HuggingFace are the source of truth**; the hub's Postgres holds only lightweight operational state and lineage lookups. Any node that can reach the hub URLs can join.

---

## 3. Core decisions

### 3.1 Pi as the runtime primitive everywhere

- Agent roles are **pi agent sessions** driven through the pi SDK (`createAgentSession`) inside containers. No bespoke agent runtime.
- Research-lab capabilities are **purpose-built agent tools** (e.g. `record_audit`, `record_director_note`) and hub services (scheduler, gate engine) — with community pi packages *evaluated and adopted where they fit* (ongoing workstream, PLAN.md M5).
- Dashboard chat will be backed by pi sessions via a chat bridge in the supervisor (M8).

### 3.2 Hub-and-worker, pull-only, multi-node from day one

- Hub runs supervisor, Postgres, dashboard, gitserver — one docker-compose stack. Workers run the worker service (+ optional model server) and join by announcing themselves at the hub's well-known registration URL (R4).
- Resilience model: **leases with heartbeats; lease expiry re-queues** (bounded attempts, then the activity escalates); SSE consumers resume from the last event id (dashboard stream). Exact semantics are normative in [`protocols/README.md`](protocols/README.md) §4 — verified behaviors, not aspirations.
- Multi-node is a **v1 requirement**, exercised by the demo (two worker containers on one host); true cross-host join — CA/token distribution over the network — is first exercised in P4.

### 3.2.1 Git plane (R1–R3, designed)

The hub serves research project repos over **HTTPS** via a lean **gitserver sidecar**: nginx + git-http-backend (fcgiwrap), bare repos on a hub volume (`data/repos/*.git`), smart HTTP. TLS terminates with a server certificate from a **bare-bones internal CA** (hub-generated at bootstrap; the CA cert is distributed to workers, `http.sslCAInfo`). Workers authenticate with **hub-issued tokens**; the hub maintains the policy mapping jobs → allowed refs → tokens.

**Why:** with the hub as origin, the hub always holds the latest committed state the moment a worker pushes; the auditor and mechanical gates can therefore operate on *committed* state hub-side, and dependent tasks build on merged main — no evidence blob uploads, no injection plumbing.

**Branch governance (task branches + audited-complete merge):**
- Each task (planning-graph activity) gets a **task branch**: the hub pre-creates `refs/tasks/<activity>` at the current `main` tip when promoting the activity; the job spec carries `{branch, base_sha}`. Refs are scoped to a graph revision (activity ids are unique within it); re-promoting a failed activity **reuses its existing ref and appends** — a revised graph mints new activity ids and thus new refs.
- A **pre-receive hook** (policy file generated by the hub) accepts a push only if: the ref matches the job's task branch, the pusher token matches, and the push is a **fast-forward** — pushes to any other ref, including `main`, are **denied server-side**. One carve-out: a **hub-granted, one-time rebase/force authorization** on that task ref (see landing below). Repair iterations and lease-expiry requeues **append** on the same branch — partial dead work stays visible for audit. The hook is thin: it calls a supervisor API that validates the push and **atomically consumes** any one-time authorization (no shared-policy-file races); a consumed-but-failed push re-grants automatically at the next landing attempt. Ref **deletions and tag pushes are denied outright**. A separate **operator token** (bootstrap-issued) may push to `main` — the human/director write path for `goal.md`, graph revisions, and human fixes (v1: operator pushes via git CLI; dashboard-mediated authoring later). Hub-side writers (merges, secretary notes, director plan revisions) commit through the same serialized per-repo writer.
- **Audited-complete merge:** `main` advances only after the task passes its exit gate **and** the auditor is satisfied. Landing is **serialized per repo**. If the branch tip is a descendant of current `main` → **fast-forward merge**. Otherwise (concurrent branches moved `main`) → the hub **SSE-instructs the owning worker to fetch, rebase onto updated `main`, and push** (worker-side work; the rebase push is non-ff by definition, hence the one-time force authorization), followed by **another audit round** on the new tip, then merge. The instruction always has a recipient: the worker remains operational until the merge (§4).
- **Churn-minimizing scheduler:** rebase requests are issued only when a branch's landing turn arrives — never eagerly after each merge — and may be held off while concurrency is high (batched landings).
- **Retention — always preserve:** failed-task branches are never deleted. For **every** attempt the secretary commits a **summary note to `main`** (what was attempted, gate/audit outcome, links to the branch), so the repo itself carries the attempt history. Note commits go through the **same serialized per-repo writer** as merges (two hub-side writers, one landing queue). Preserved-forever branches + full clones per task trade disk/clone cost for auditability — growth policy is a tracked open question (§10). HF artifact deletion remains a separate, explicit decision (default: retain).

### 3.3 State: git + HuggingFace are the truth; Postgres is lightweight state and lookups

- **Git (task branches → merged main):** research content and evidence — code, configs, planning graphs, skills, reports, metrics, retrospectives, attempt notes. This is the durable research record, always current on the hub.
- **HuggingFace Hub:** checkpoints, datasets, and other large artifacts — accessed through a hub-side **hf-mount** sidecar (NFS backend) that mounts the project's HF Bucket; **workers hold no HF tokens** (the single `HF_TOKEN` lives hub-side). Workers write artifacts into their per-task bucket subfolder, commit the git-side pointer on the task branch, and read back through the mount before reporting done. Artifact lineage (path ↔ git commit ↔ HF revision) is indexed by the secretary. Per-task subfolders sidestep hf-mount's lack of multi-writer coordination; its ~10–30 s eventual consistency is acceptable for artifacts.
- **Postgres (hub only, lightweight):** operational state and lookups — jobs, leases, progress events, plans/activities, approvals, gate verdicts, agent log, nodes — plus the **lineage index** (formerly the artifacts content store). The dashboard is a live projection of this state; **no research content lives in Postgres** — meaning evidence **files/blobs** never do. Scalar progress metrics (loss values inside `metrics` events) are operational telemetry, not content, and stay.
- **Removed by this refinement:** the evidence-upload API and the `inputs_evidence` injection — gates and the auditor read evidence from the bare repo (committed state), and dependent tasks receive upstream evidence by cloning `main` after merges. Workers access repos exclusively through the gitserver (clone/fetch/push); nothing durable ever lives only inside a worker container.

### 3.4 Two-repo bootstrap model

- **Framework repo (this repo, public):** compose stack, supervisor, extensions, dashboard, protocol specs, demo. `git clone && docker-compose up` bootstraps the lab.
- **Project repo (per research project, private/public case-by-case):** goal, planning graphs, experiment code, task-specific worker skills, artifacts. Served by the hub's gitserver; workers do a **full in-container checkout per task** (clone from the gitserver URL with CA + token; checkout the task branch; delete on task end). **No worktrees; no `/repo` bind mount on workers.**
- Skills are versioned repo artifacts: agents propose skill edits; changes land via the same gate/audit/approval flow as any other work, are auditable in git history, and can be **A/B-tested on identical inputs** (branch-based A/B — two task-style checkouts; worker worktrees are removed by R3) when the director or human decides.
- **Skill placement:** role-shaping skills (auditor, reflector, secretary personas — hub-side role concerns) live in the **framework repo**; project repos carry only **worker-task-specific skills** (the demo carries a single one: `skills/demo/`). Role-shaping skills are authored framework-side — secretary in R6, auditor/reflector in R7.

### 3.5 Hybrid inference + model tiers

- Agent inference reaches providers through OpenAI-style endpoints: remote APIs (z.ai GLM today) and **local model servers** — llama.cpp for GGUF quants (vLLM dropped GGUF support; safetensors deployments may use vLLM), both behind the hub's `local` provider tier. An optional **LiteLLM profile** exists for gateway-style routing when needed.
- **Role→model mapping is configuration** (`AUDITOR_MODEL`, `DIRECTOR_MODEL`; per-project mapping in `config/project.yaml`), backed by a **model-tier registry** that also drives the escalation ladder's "second opinion from a more capable model."
- **Resource contention policy:** when inference and experiment compute share a node, the worker's compose profile enforces resource quotas (GPU memory/CPU reservations & limits). Soft quotas are imperfect (no hard VRAM isolation without MIG); heavy training campaigns may instead schedule on nodes without a resident model server.

---

## 4. Deployment model (docker-compose)

- **Hub compose stack:** `supervisor`, `postgres`, `dashboard`, `gitserver`, `hf-mount` (HF Bucket over NFS; holds the only `HF_TOKEN`) (+ optional `litellm`). GPU services optional.
- **Worker compose profile:** `worker-a`/`worker-b` (+ optional `llamacpp` local model server). Same image family, different profile/env (`HUB_URL`, node labels like `gpu=rtx5090`, capability tags).
- **Worker lifecycle (R-series):** one task per container — a worker starts, registers (well-known URL → session id + per-session SSE endpoint), waits for instructions, and executes exactly one task **through its full lifecycle**: checkout → work → push → gate/audit → repair/rebase as instructed → merge. It stays operational until the **secretary signals exit-eligibility** (after the audited-complete merge, or after a failed attempt is closed and its summary note committed), then exits; compose `restart: always` recreates it. Damage does not accumulate across tasks by construction. A worker that dies mid-task is never rescued — its lease expires and the task requeues from scratch. Idle = subscribed and waiting (no polling loop).
- **Git bootstrap:** a bootstrap step generates the internal CA + gitserver cert, creates `data/repos/*.git` bare repos, and issues worker tokens; the demo project is **seeded hub-side** (`data/repos/demo.git` from `examples/demo-project`) — the framework repo is no longer bind-mounted to workers.
- **Workload hosting (security):** workers host job workloads as **subprocesses inside the worker container** — the host docker socket is *never* mounted. Rationale: workers execute untrusted research code (pulled dependencies, experiment scripts); a compromised workload must not be able to escalate to the host via the docker daemon. Confinement boundary = the worker container itself. Consequences: (a) the job spec's `image` is an **advisory stack declaration**, matched via node capability tags (`requirements.tags` vs `NODE_TAGS`); (b) worker images must be provisioned with the runtimes they serve; (c) cancel/timeout is enforced by SIGKILL on the workload's process group.
- Scheduling: jobs declare requirements (e.g., `gpu: true`, `vram: 24GB`, `tags: [python:3.12]`); the hub matches against worker capability tags and lease capacity.
- Secrets: hub-side `.env` (API keys, HF token, git credentials) never enters the public repo; a `.env.example` documents required variables. The **hub HTTP API is served under the same internal CA** as the gitserver — worker→hub registration/status/acks ride TLS too, not just git. Workers receive only their git token + CA cert; per-job env passthrough is explicit (`JOB_ENV_*`).

---

## 5. Agent roster & governance

### 5.1 Roles

| Role | Model tier (per-project config) | Does | Never does |
|---|---|---|---|
| **Director** | strong | Drafts plans, supplies **commander's intent** (what + why), approves reflector proposals, handles escalations, intervenes | Executes research work itself |
| **Workers** (N) | mid (varies by task) | Execute one task per container (operational through gate/audit/landing): checkout task branch, run workloads, write artifacts (task branch + HF mount), push, report status, write reports + retrospectives | Approve their own gates; push outside their task branch |
| **Auditor** | strong | At each exit gate: verifies criteria met and claims are **evidenced and reasonable** — working hub-side on **committed state** (task-branch tip in the bare repo, incl. post-rebase re-audit); anomaly scans over the event stream | Modify plans or artifacts |
| **Secretary** | small/mid | **Shapes the work handoff:** operationalizes director intent into worker-facing specifics (artifact paths/refs, follow-up requests — retrospective prompts, summarize-work requests, archiving instructions) and **executes** them; retention executor (preserve branch + note to main; **owns the worker exit signal** — post-merge / attempt-closure); taxonomies/indices/lineage | Decide research direction |
| **Reflector** | strong | Cross-campaign reflection: proposes changes to plans and **skills** from accumulated retrospectives/audits | Apply changes directly |

*Implementation status:* director + auditor are live (`hub/src/agents.ts`). Secretary (R6) and reflector (M9) are designed; role-shaping skills will be authored framework-side (`skills/` — secretary in R6, auditor/reflector in R7).

### 5.2 Governance flows

**Plan approval**
1. Human states the **goal** (approved by definition — human-authored).
2. Director drafts the planning graph; **human approves the first plan** via dashboard approval inbox.
3. During execution, the director may revise plans autonomously **iff** the goal is unchanged **and** the auditor is satisfied.
4. **Substantial changes** (progress blocked, or next planned work is low-value given new findings) go back to the human.

**Exit gates**
1. Worker completes a task: pushes artifacts + evidence to its **task branch**, then reports status via API **with the pushed commit SHA** (evidence = committed files: metrics, seeds, configs; reproducibility fields are first-class).
2. **Mechanical gates** read exactly that SHA from the bare repo (never "the tip" — appends/repairs can't shift what gets audited) and resolve criteria against the job's declared `outputs.evidence` paths — **no tree-wide search**, so a sabotaged worker can't satisfy a criterion with a decoy file. The **auditor** verifies criteria and that claims are evidenced/reasonable on the same committed state.
3. Pass → task is **audited-complete**; the hub merges the task branch into `main` (§3.2.1). Fail → routes back to the worker for **repair** (SSE instruction; next iterations append on the same branch); after **two failed repairs on the same deficiency the hub itself escalates** to the director (hub-enforced loop bound, not worker discipline).

**Escalation ladder**
1. Worker may escalate: "task unachievable as planned."
2. Director resolves by: (a) **second opinion** from another worker on a more capable model, (b) **changing the plan** (within §5.2 rules), or (c) **escalating to the human**.

**Reflective learning**
1. Every exit produces a worker retrospective (part of the gate bundle).
2. Reflector aggregates retrospectives + audit anomalies and proposes plan/skill changes.
3. Director approves or escalates to human; approved skill changes are committed to the project repo (auditable), optionally A/B-tested on identical inputs first (branch-based A/B, M9).

### 5.3 Planning graph

- A **DAG of research activities** with **exit gates** per activity, stored as a versioned YAML file in the project repo (reference: `examples/demo-project/plan/graph.yaml`). The hub parses and validates it (unknown deps, cycles) and freezes it on approval.
- Activities reference jobs (via the job protocol) and downstream dependencies; gates reference **mechanically checkable criteria** (job state, evidence existence/fields/values) plus agent-deferred reasonableness checks.
- Reviewed/approved **before** execution begins (first plan: by the human; revisions: director under §5.2 rules).
- The dashboard renders the current graph read-only inside approval forms (interactive DAG visualization deferred).

---

## 6. Job protocol

A **job** is any long-running scripted work — training run, eval sweep, analysis pipeline, even agent-driven synthesis — that a worker hosts as a **subprocess inside its own container** (see §4 security). The protocol is **stack-agnostic**: the framework standardizes only the *contract*; the normative specification (JSON schemas, progress/terminal semantics, lease & cancellation behavior, validation tooling) lives in [`protocols/README.md`](protocols/README.md) with schemas in `protocols/`.

Design-level contract summary:
- **Spec:** id, activity/plan linkage, `{branch, base_sha}` (task ref pre-created by the hub), advisory `image` (stack declaration matched via node tags), command, requirements, evidence/artifact output paths (now git-committed paths on the task branch), timeout.
- **Progress:** JSON-lines events (`t`, `pct`, `eta_s`, `stage`, `metrics`) discoverable at any `progress.jsonl` under the workspace; terminal `state: succeeded|failed`; exit code mirrors the terminal state.
- **Evidence-first:** evidence is **committed to the task branch**; gates and the auditor read it from the bare repo (hub-side git). Upstream evidence reaches dependent tasks through **merged `main`** — no upload API, no injection.
- **Agent observability:** agent outcomes (audits, recommendations, lifecycle events) are published on the same event bus as job events, so the dashboard's activity feed shows agents and jobs uniformly.

---

## 7. Dashboard

- **Ops view (live):** job progress/ETA, worker/node health, agent activity feed, SSE updates with resume; gate results with criteria checklists, auditor notes, agent log.
- **Approval inbox (live):** plan approvals and escalations as structured cards with agent recommendations; approve/reject/resolve actions.
- **Ad hoc chat (M8, planned):** talk to any agent role about ongoing work, backed by pi sessions via the supervisor's chat bridge.
- Single-user, token auth (`AUTH_TOKEN`). DAG visualization: future.

## 7.1 SSE worker-agent instruction protocol (R4, designed)

All **hub-initiated worker instructions** are SSE events — one standard channel for everything the hub pushes to worker agents:

- **Work assignment** (register-then-offer: workers announce at a well-known URL on start; the hub issues a session id and offers tasks over the session's stream — replacing the `GET /api/work` poll).
- **Auditor feedback** on gate failures — the worker's Pi consumes it as a **turn input** for the repair iteration.
- **Retrospective prompt** (authored by the secretary as part of the work handoff).
- **Repair, rebase, and cancel instructions** (rebase carries the target `main` SHA + the one-time force authorization for the task ref, §3.2.1; cancel is the hub-initiated stop, complementing lease-expiry requeue now that polling is gone).
- **Exit signal** — the secretary's post-merge (or attempt-closure) release; until then the worker stays operational and addressable.
- Future hub-pushed work of any kind.

**Session model:** workers are **uniform until they register** — announcing at the well-known URL issues the identity (session id, scoped to the container lifetime) that makes the worker addressable; each session has its own SSE endpoint (fresh buffer — no last-event-id needed). Idle workers simply wait for events. Instructions are redelivered across a live session's transient SSE reconnects (bounded buffer, idempotent acks). There is deliberately **no rescue**: a worker that dies mid-task loses all worker-side context — its lease expires and the task is **requeued from scratch** as a fresh attempt on the same branch (prior appends remain visible for audit; rescuing half-dead state would complicate the workflow beyond its value). Worker→hub remains git push (content) + API calls (status/progress/acks).

**Agent/runner division (worker-side):** the Pi agent **decides** — it consumes instructions as turn inputs and plans the work — while the M3 runner remains the **executor**: clone/checkout, workload spawn/SIGKILL, progress tailing, commit/push, and status calls become agent-invoked tools. Agentization reuses the runner; it does not replace it.

---

## 8. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Audits become rubber stamps | Evidence is committed state audited pre-merge (audited-complete gate to main); auditor checks are skill-driven and versioned; main never holds unaudited work |
| Agent-edited skills drift/inject | Skills live in git; director approval required; optional A/B on identical inputs |
| Pull-only cancellation latency | Leases + heartbeats with tunable poll interval; cancellation honored on the next status/event exchange; stale-attempt writes rejected (409) |
| HF/git lineage gaps | Lineage index rows record git commit + HF revision together; the secretary indexes both |
| Concurrent landing churn (rebases) | Serialized per-repo landing; ff-first; rebase requested only at landing turn and deferrable under high concurrency; one-time force windows prevent abuse |
| Gitserver becomes trusted attack surface | Tokens scoped job→ref by hub policy; internal CA only for the git endpoint; pushes ff-only (+ authorized rebases); workers never touch host or Postgres |
| Worker death mid-task | No rescue by design: lease expiry requeues the task from scratch (fresh attempt, same branch — dead work stays visible for audit); exit-after-merge is a single clean exit, not a crash loop; restart backoff against an unreachable hub |
| "More capable model" undefined | Model-tier registry in per-project config is the single source of capability ordering |
| GPU contention (inference vs training) | Compose quotas; heavy campaigns prefer nodes without resident model servers; documented soft-limit caveat |
| Public repo leaks secrets | Secrets only in hub `.env`; worker git tokens issued by hub, CA private key hub-side only; CI checks |
| Stack-agnostic boilerplate tax on early projects | Starter skills + job-protocol helper scripts in project templates (demo project demonstrates the pattern) |
| Community-package churn | Purpose-built agent tools + hub services own the core; community packages are additive and swappable |

---

## 9. Phased rollout

1. **P0 — Protocols & demo scaffold: done.**
2. **P1 — Job plane: done** (hub API + Postgres + SSE, worker runner, two compose workers; E2E-verified incl. lease-expiry requeue).
3. **P2 — Governance plane: done** (planning-graph engine, mechanical gates, repair→escalation, director + auditor agents, approval inbox).
4. **P3 — Experience: partial** (dashboard ops view + approvals live; chat bridge M8; reflector automation M9).
5. **R-series — Git plane + worker-agent refinement (designed; PLAN.md):** R1 gitserver+CA+tokens → R2 task branches+hook → R3 in-container checkout rework → R4 SSE worker protocol (sessions, instructions, register-then-offer) → R5 auditor/gates on committed state → R6 secretary (work-handoff agent) → R7 demo seeding hub-side + validation rework. The R-series leads the single upcoming timeline (PLAN.md); the P3/M-series remainder follows it: M7 approvals/gates UX polish, M8 chat bridge, M9 reflector + skill-change pipeline, M10 packaging & public release.
6. **P4 — Real compute (post-release):** first real GPU campaign on the 5090; Spark joins as a second worker; tier config against real models.

---

## 10. Open design questions

- SSE instruction event schema: envelope (kind, job/branch correlation, payloads incl. rebase target SHA and secretary operational details), ack mechanics, offer/accept handshake for work assignment (identity model decided: uniform-until-registered, no-rescue requeue, bounded reconnect buffers) (R4).
- **Git-plane event taxonomy:** branch-created / pushed / audited-complete / merged / note-committed event schema for the dashboard feed (emitted R7, rendered M7).
- **Repo growth policy:** preserved branches + full clones per task vs. disk/clone cost — quotas, optional shallow fetch depth, GC cadence.
- CA + token lifecycle: generation, rotation, revocation; trust bootstrap mechanics for workers (R1).
- Rebase churn policy parameters: concurrency threshold and hold-off timing for deferred landings (R2/R5 defaults).
- Hub-side git access for gates/auditor/secretary: git CLI in the hub container vs libgit2-style library (R5 implementation choice).
- Secretary agent scope (R6): prompt/tool surface; which follow-up request types exist at first release.
- Chat-session bridge mechanics (M8): chat-addressable sessions, history policy, context injection from run state.
- Model-tier registry: full per-project config schema (today: env-driven role→model + demo sketch).
- Reflector automation (M9): trigger cadence, proposal → A/B pipeline.
- Substantial-change detection: what formally triggers human re-approval beyond blocked progress / low-value next work.
