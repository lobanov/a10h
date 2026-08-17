# Pi Autoresearch Lab — Design Doc

**Status:** v1.0 — implemented alpha. Job plane, governance plane, agents (director/auditor), dashboard ops+approvals are live and E2E-verified; see [PLAN.md](PLAN.md) for status. This document records **decisions and architecture**; operational and protocol detail lives in [`protocols/README.md`](protocols/README.md) and the `.agents/skills/autoresearch-e2e/` skill.
**Repo role:** This is the *framework repo* — the multi-agent system itself. Research content lives in separate project repos.

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
| 6 | Agent hierarchy (director, workers, auditor, librarian) | pi SDK sessions in containers; roster in §5 |
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
                        ┌─────────────────────────── HUB (docker-compose) ───────────────────────────┐
                        │                                                                              │
  operator ──browser──► │  Dashboard (web UI: ops view + approval inbox [chat: M8])                   │
                        │     │  SSE                    │ REST                     ▲ pi sessions     │
                        │     ▼                         ▼                          │ (chat bridge)    │
                        │  Event bus ◄──────────── Supervisor (Node/TS) ────────────┘                  │
                        │     │                        │  agent roles as pi SDK sessions:            │
                        │     ▼                        │   director · auditor (live)                 │
                        │  Postgres (jobs, events,      │   reflector · librarian (M9, skills exist)   │
                        │  gates, approvals, audits)   │                                              │
                        │                              │                                              │
                        │  LLM providers ◄────────────┘ remote APIs or local llama.cpp/vLLM           │
                        │  (LiteLLM: optional profile)                                                 │
                        └──────────▲───────────────────┬──────────────────────────────────────────────┘
             pull work (HTTP) +    │                   │  work + events over
             push status (HTTP+SSE)│                   ▼  pull-only HTTP + SSE
                        ┌──────────┴─────────┐   ┌────────────────────┐   ┌────────────────────┐
                        │ WORKER: 5090 host  │   │ WORKER: DGX Spark  │   │ WORKER: future node│
                        │ runner + workloads │   │ runner + workloads │   │ runner + workloads │
                        │ as subprocesses    │   │ as subprocesses    │   │ as subprocesses    │
                        │ (+ optional LLM)   │   │ (+ optional LLM)   │   │                    │
                        └────────────────────┘   └────────────────────┘   └────────────────────┘
```

**One rule makes the topology simple:** workers never accept inbound connections and never touch Postgres. They *pull* work from the hub over HTTP and push status/events back. Any node that can reach the hub URL can join.

---

## 3. Core decisions

### 3.1 Pi as the runtime primitive everywhere

- Agent roles are **pi agent sessions** driven through the pi SDK (`createAgentSession`) inside containers. No bespoke agent runtime.
- Research-lab capabilities are **purpose-built agent tools** (e.g. `record_audit`, `record_director_note`) and hub services (scheduler, gate engine) — with community pi packages *evaluated and adopted where they fit* (ongoing workstream, PLAN.md M5).
- Dashboard chat will be backed by pi sessions via a chat bridge in the supervisor (M8).

### 3.2 Hub-and-worker, pull-only, multi-node from day one

- Hub runs supervisor, Postgres, dashboard — one docker-compose stack. Workers run the runner service (+ optional model server) and register by polling the hub's work endpoint.
- Resilience model: **leases with heartbeats; lease expiry re-queues** (bounded attempts, then the activity escalates); SSE consumers resume from the last event id. Exact semantics are normative in [`protocols/README.md`](protocols/README.md) §4 — verified behaviors, not aspirations.
- Multi-node is a **v1 requirement**, exercised by the demo (two compose workers), not deferred.

### 3.3 State: hub-only Postgres; artifacts: git + HuggingFace

- **Postgres (hub only):** job lifecycle, progress events, agent activity, gate decisions, audit results, approval queue. Append-heavy, event-oriented schema; the dashboard is a live projection.
- **Project repo (git):** code, configs, planning graphs, skills, reports, metrics (small JSON/CSV), retrospectives, audit reports. This is the durable research record.
- **HuggingFace Hub:** checkpoints, datasets, and other large artifacts. Artifact lineage records **both** locations (git commit ↔ HF revision), and the librarian indexes both.
- Workers access the project repo via a **read-only mount**; per-job checkouts (clone or worktree) are ephemeral; nothing durable ever lives only inside a container.

### 3.4 Two-repo bootstrap model

- **Framework repo (this repo, public):** compose stack, supervisor, extensions, dashboard, protocol specs, demo. `git clone && docker-compose up` bootstraps the lab.
- **Project repo (per research project, private/public case-by-case):** goal, planning graphs, experiment code, skills, artifacts. Checked out **inside worker containers** (clone or worktree strategy per job) where workloads execute.
- Skills are versioned research-repo artifacts: agents propose skill edits; changes land via the same gate/audit/approval flow as any other work, are auditable in git history, and can be **A/B-tested in a separate worktree on identical inputs** when the director or human decides.

### 3.5 Hybrid inference + model tiers

- Agent inference reaches providers through OpenAI-style endpoints: remote APIs (z.ai GLM today) and **local model servers** — llama.cpp for GGUF quants (vLLM dropped GGUF support; safetensors deployments may use vLLM), both behind the hub's `local` provider tier. An optional **LiteLLM profile** exists for gateway-style routing when needed.
- **Role→model mapping is configuration** (`AUDITOR_MODEL`, `DIRECTOR_MODEL`; per-project mapping in `config/project.yaml`), backed by a **model-tier registry** that also drives the escalation ladder's "second opinion from a more capable model."
- **Resource contention policy:** when inference and experiment compute share a node, the worker's compose profile enforces resource quotas (GPU memory/CPU reservations & limits). Soft quotas are imperfect (no hard VRAM isolation without MIG); heavy training campaigns may instead schedule on nodes without a resident model server.

---

## 4. Deployment model (docker-compose)

- **Hub compose stack:** `supervisor`, `postgres`, `dashboard`, `litellm`. GPU services optional.
- **Worker compose profile:** `worker-a`/`worker-b` (+ optional `llamacpp` local model server). Same image family, different profile/env (`HUB_URL`, node labels like `gpu=rtx5090`, capability tags).
- **Workload hosting (security):** workers host job workloads as **subprocesses inside the worker container** — the host docker socket is *never* mounted. Rationale: workers execute untrusted research code (pulled dependencies, experiment scripts); a compromised workload must not be able to escalate to the host via the docker daemon. Confinement boundary = the worker container itself. Consequences: (a) the job spec's `image` is an **advisory stack declaration**, matched via node capability tags (`requirements.tags` vs `NODE_TAGS`); (b) worker images must be provisioned with the runtimes they serve; (c) cancel/timeout is enforced by SIGKILL on the workload's process group.
- Scheduling: jobs declare requirements (e.g., `gpu: true`, `vram: 24GB`, `tags: [python:3.12]`); the hub matches against worker capability tags and lease capacity.
- Secrets: hub-side `.env` (API keys, HF token, git credentials) never enters the public repo; a `.env.example` documents required variables. Workers get no secrets by default; per-job env passthrough is explicit (`JOB_ENV_*`).

---

## 5. Agent roster & governance

### 5.1 Roles

| Role | Model tier (per-project config) | Does | Never does |
|---|---|---|---|
| **Director** | strong | Drafts plans, assigns work, approves reflector proposals, handles escalations, intervenes | Executes research work itself |
| **Workers** (N) | mid (varies by task) | Execute activities: write code, run jobs, analyze results, write reports + retrospectives | Approve their own gates |
| **Auditor** | strong | At each exit gate: verifies criteria met and claims are **evidenced and reasonable**; runs anomaly scans over the event stream | Modify plans or artifacts |
| **Librarian** | small/mid | Maintains taxonomies, indices, artifact registry (git + HF), lessons index, literature notes | Decide research direction |
| **Reflector** | strong | Cross-campaign reflection: proposes changes to plans and **skills** from accumulated retrospectives/audits | Apply changes directly |

*Implementation status:* director + auditor are live (`hub/src/agents.ts` — recommendations on escalations, reasonableness audits on every gate result). Reflector + librarian are M9; their operating skills already ship in the demo project (`examples/demo-project/skills/`).

### 5.2 Governance flows

**Plan approval**
1. Human states the **goal** (approved by definition — human-authored).
2. Director drafts the planning graph; **human approves the first plan** via dashboard approval inbox.
3. During execution, the director may revise plans autonomously **iff** the goal is unchanged **and** the auditor is satisfied.
4. **Substantial changes** (progress blocked, or next planned work is low-value given new findings) go back to the human.

**Exit gates**
1. Worker completes an activity and produces: artifacts, evidence (metrics/refs), claims, and a **retrospective**.
2. **Auditor** verifies gate criteria and that claims are evidenced/reasonable (reproducible metrics files, seeds, env pins are first-class job outputs).
3. Pass → downstream activities unlock. Fail → routes back to the worker for **repair**.

**Escalation ladder**
1. Worker may escalate: "task unachievable as planned."
2. Director resolves by: (a) **second opinion** from another worker on a more capable model, (b) **changing the plan** (within §5.2 rules), or (c) **escalating to the human**.

**Reflective learning**
1. Every exit produces a worker retrospective (part of the gate bundle).
2. Reflector aggregates retrospectives + audit anomalies and proposes plan/skill changes.
3. Director approves or escalates to human; approved skill changes are committed to the project repo (auditable), optionally A/B-tested in a worktree on identical inputs first.

### 5.3 Planning graph

- A **DAG of research activities** with **exit gates** per activity, stored as a versioned YAML file in the project repo (reference: `examples/demo-project/plan/graph.yaml`). The hub parses and validates it (unknown deps, cycles) and freezes it on approval.
- Activities reference jobs (via the job protocol) and downstream dependencies; gates reference **mechanically checkable criteria** (job state, evidence existence/fields/values) plus agent-deferred reasonableness checks.
- Reviewed/approved **before** execution begins (first plan: by the human; revisions: director under §5.2 rules).
- The dashboard renders the current graph read-only inside approval forms (interactive DAG visualization deferred).

---

## 6. Job protocol

A **job** is any long-running scripted work — training run, eval sweep, analysis pipeline, even agent-driven synthesis — that a worker hosts as a **subprocess inside its own container** (see §4 security). The protocol is **stack-agnostic**: the framework standardizes only the *contract*; the normative specification (JSON schemas, progress/terminal semantics, lease & cancellation behavior, validation tooling) lives in [`protocols/README.md`](protocols/README.md) with schemas in `protocols/`.

Design-level contract summary:
- **Spec:** id, activity/plan linkage, advisory `image` (stack declaration matched via node tags), command, requirements, evidence/artifact output paths, timeout.
- **Progress:** JSON-lines events (`t`, `pct`, `eta_s`, `stage`, `metrics`) discoverable at any `progress.jsonl` under the workspace; terminal `state: succeeded|failed`; exit code mirrors the terminal state.
- **Evidence-first:** files declared as `outputs.evidence` are uploaded with the job result and are the mechanical inputs to gate checks; upstream activities' evidence is materialized into dependent jobs' checkouts (transitive closure).
- **Agent observability:** agent outcomes (audits, recommendations, lifecycle events) are published on the same event bus as job events, so the dashboard's activity feed shows agents and jobs uniformly.

---

## 7. Dashboard

- **Ops view (live):** job progress/ETA, worker/node health, agent activity feed, SSE updates with resume; gate results with criteria checklists, auditor notes, agent log.
- **Approval inbox (live):** plan approvals and escalations as structured cards with agent recommendations; approve/reject/resolve actions.
- **Ad hoc chat (M8, planned):** talk to any agent role about ongoing work, backed by pi sessions via the supervisor's chat bridge.
- Single-user, token auth (`AUTH_TOKEN`). DAG visualization: future.

---

## 8. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Audits become rubber stamps | Evidence is a first-class job output (metrics, seeds, env pins); auditor checks are skill-driven and versioned |
| Agent-edited skills drift/inject | Skills live in git; director approval required; optional worktree A/B on identical inputs |
| Pull-only cancellation latency | Leases + heartbeats with tunable poll interval; cancellation honored on the next status/event exchange; stale-attempt writes rejected (409) |
| HF/git lineage gaps | Artifact registry rows record git commit + HF revision together; librarian indexes both |
| "More capable model" undefined | Model-tier registry in per-project config is the single source of capability ordering |
| GPU contention (inference vs training) | Compose quotas; heavy campaigns prefer nodes without resident model servers; documented soft-limit caveat |
| Public repo leaks secrets | Secrets only in hub `.env`; demo uses no credentials; CI checks |
| Stack-agnostic boilerplate tax on early projects | Starter skills + job-protocol helper scripts in project templates (demo project demonstrates the pattern) |
| Community-package churn | Purpose-built agent tools + hub services own the core; community packages are additive and swappable |

---

## 9. Phased rollout

1. **P0 — Protocols & demo scaffold: done** (schemas, emitters, validator; demo project).
2. **P1 — Job plane: done** (hub API + Postgres + SSE, worker runner, two compose workers; E2E-verified incl. lease-expiry requeue).
3. **P2 — Governance plane: done** (planning-graph engine, mechanical gates, repair→escalation, director + auditor agents, approval inbox).
4. **P3 — Experience: partial** (dashboard ops view + approvals live; chat bridge M8; reflector + librarian automation M9).
5. **P4 — Real compute (next):** first real GPU campaign on the 5090; Spark joins as a second worker; tier config against real models.

---

## 10. Open design questions

- Chat-session bridge mechanics (M8): which sessions are chat-addressable; history policy; context injection from current run state.
- Model-tier registry: full per-project config schema (today: env-driven role→model + demo `config/project.yaml` sketch).
- Reflector + librarian automation (M9): trigger cadence, proposal → A/B-worktree pipeline.
- Community-package shortlist & evaluation criteria (ongoing workstream; adopt-or-skip ADRs in `docs/adr/`).
- Substantial-change detection: what formally triggers a "substantial change" needing human re-approval beyond blocked progress / low-value next work.
