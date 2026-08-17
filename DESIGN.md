# Pi Autoresearch Lab — Design Doc

**Status:** Draft v0.1 (from Grill Me session, resolved decisions)
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
| 4 | Ad hoc chat about ongoing work | Dashboard chat, backed by pi sessions |
| 5 | Hybrid inference (RTX 5090, DGX Spark, remote APIs) | LiteLLM gateway + per-project model-tier config; compose resource quotas on shared nodes |
| 6 | Agent hierarchy (director, workers, auditor, librarian) | pi SDK sessions in containers; roster in §5 |
| 7 | docker-compose deployment | Framework repo bootstraps via `docker-compose up`; spokes join by running their compose profile |
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
  operator ──browser──► │  Dashboard (web UI: ops view, approval inbox, chat)                          │
                        │     │  SSE                    │ REST                     ▲ pi sessions     │
                        │     ▼                         ▼                          │ (chat bridge)    │
                        │  Event bus ◄──────────── Supervisor (Node/TS) ────────────┘                  │
                        │     │                        │  runs agent roles as pi SDK sessions:        │
                        │     ▼                        │   director · workers · auditor ·            │
                        │  Postgres (jobs, events,      │   librarian · reflector                     │
                        │  gates, approvals, audits)   │                                              │
                        │                              │                                              │
                        │  LiteLLM gateway ◄───────────┘ agent inference                              │
                        └──────────▲───────────────────┬──────────────────────────────────────────────┘
             pull work (HTTP) +    │                   │  serve jobs over
             push status (SSE)     │                   ▼  pull-only HTTP+SSE
                        ┌──────────┴─────────┐   ┌────────────────────┐   ┌────────────────────┐
                        │ SPOKE: 5090 host   │   │ SPOKE: DGX Spark   │   │ SPOKE: future node │
                        │ runner + jobs      │   │ runner + jobs      │   │ runner + jobs      │
                        │ (+ optional vLLM)  │   │ (+ optional vLLM)  │   │                    │
                        └────────────────────┘   └────────────────────┘   └────────────────────┘
```

**One rule makes the topology simple:** spokes never accept inbound connections and never touch Postgres. They *pull* work from the hub over HTTP and *stream* status back over SSE. Any node that can reach the hub URL can join.

---

## 3. Core decisions

### 3.1 Pi as the runtime primitive everywhere

- Every agent role (director, workers, auditor, librarian, reflector) is a **pi agent session** driven through the pi SDK (`createAgentSession`) inside containers. No bespoke agent runtime.
- Research-lab capabilities are **pi extensions** (custom tools + lifecycle hooks): job protocol tools, gate/audit tools, librarian indexing, dashboard event bridge.
- **Hybrid adoption:** community pi packages (subagent orchestration, observability, etc.) are *evaluated and adopted where they fit*; research-specific pieces are purpose-built. Package evaluation is an explicit workstream (see PLAN.md M5), not a one-time choice.
- Dashboard chat is backed by pi sessions via a chat bridge in the supervisor.

### 3.2 Hub-and-spoke, pull-only, multi-node from day one

- Hub runs supervisor, Postgres, dashboard, LiteLLM — one docker-compose stack.
- Spokes run a runner service (+ optional model server). They register by polling the hub's work endpoint.
- Resilience: spokes hold **leases** on jobs with heartbeats; the hub re-queues work when leases expire; SSE streams resume with last-event IDs. Cancellation latency is bounded by the poll interval (tunable).
- Multi-node (5090 box + DGX Spark + future) is a **v1 requirement**, exercised by the demo (two simulated spokes), not deferred.

### 3.3 State: hub-only Postgres; artifacts: git + HuggingFace

- **Postgres (hub only):** job lifecycle, progress events, agent activity, gate decisions, audit results, approval queue. Append-heavy, event-oriented schema; the dashboard is a live projection.
- **Project repo (git):** code, configs, planning graphs, skills, reports, metrics (small JSON/CSV), retrospectives, audit reports. This is the durable research record.
- **HuggingFace Hub:** checkpoints, datasets, and other large artifacts. Artifact lineage records **both** locations (git commit ↔ HF revision), and the librarian indexes both.
- Spokes get repo access via mounted credentials/worktrees; nothing durable ever lives only inside a container.

### 3.4 Two-repo bootstrap model

- **Framework repo (this repo, public):** compose stack, supervisor, extensions, dashboard, protocol specs, demo. `git clone && docker-compose up` bootstraps the lab.
- **Project repo (per research project, private/public case-by-case):** goal, planning graphs, experiment code, skills, artifacts. Checked out **inside** agent/runner containers, potentially as multiple **worktrees** (one per activity/worker).
- Skills are versioned research-repo artifacts: agents propose skill edits; changes land via the same gate/audit/approval flow as any other work, are auditable in git history, and can be **A/B-tested in a separate worktree on identical inputs** when the director or human decides.

### 3.5 Hybrid inference via LiteLLM + model-tier registry

- All agent inference (and optionally local model serving) flows through **LiteLLM**: remote APIs (Anthropic, OpenAI, …) and local servers (vLLM on the 5090/Spark) behind one OpenAI-style endpoint.
- **Role→model mapping is per-project configuration**, backed by a **model-tier registry** (e.g., `small`, `mid`, `strong`, `strongest`) that also drives the escalation ladder's "second opinion from a more capable model."
- **Resource contention policy:** when inference and experiment compute share a node, the spoke's compose profile enforces resource quotas (GPU memory/CPU reservations & limits). Soft quotas are imperfect (no hard VRAM isolation without MIG); the policy is documented, and heavy training campaigns may instead schedule on nodes without a resident model server.

---

## 4. Deployment model (docker-compose)

- **Hub compose stack:** `supervisor`, `postgres`, `dashboard`, `litellm`. GPU services optional.
- **Spoke compose profile:** `runner` (+ optional `vllm`). Same image family, different profile/env (`HUB_URL`, node labels like `gpu=rtx5090`, capability tags).
- Scheduling: jobs declare requirements (e.g., `gpu: true`, `vram: 24GB`, `stack: pytorch`); the hub matches against spoke capability tags and lease capacity.
- Secrets: hub-side `.env` (API keys, HF token, git credentials) never enters the public repo; a `.env.example` documents required variables.

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

- A **DAG of research activities** with **exit gates** per activity, stored as a versioned file in the project repo (YAML; schema sketched in the demo).
- Activities reference jobs (via the job protocol) and downstream dependencies; gates reference checkable criteria.
- Reviewed/approved **before** execution begins (first plan: by the human; revisions: director under §5.2 rules).
- The dashboard renders the current graph read-only inside approval forms (interactive DAG visualization deferred).

---

## 6. Job protocol (v0 sketch)

A **job** is any long-running scripted work — training run, eval sweep, analysis pipeline, even agent-driven synthesis — that a runner executes. The protocol is **stack-agnostic**: the framework only standardizes the *contract*.

```yaml
# job.yaml (submitted to hub)
id: train-a1b2
activity: lit-sweep/run-03          # links to planning-graph node
image: ghcr.io/acme/stack:latest    # any containerized guest OS + stack
command: ["python", "train.py", "--config", "sweep/baseline.yaml"]
worktree: runs/03                   # project-repo worktree
requirements: { gpu: false, vram: 0, cpu: 2, mem: 4G }
inputs:  [configs/sweep/baseline.yaml]
outputs:
  evidence: [runs/03/metrics.json]  # first-class, auditable
  artifacts: [runs/03/summary.md]   # git-tracked
  large: { hf: [runs/03/checkpoint] }  # HuggingFace, lineage recorded
timeout_s: 3600
```

**Progress contract** (emitted by the job, relayed by the runner):
- Heartbeat + progress events on stdout as JSON lines or a well-known file (`./progress.jsonl`):
  `{"t": ..., "pct": 42, "eta_s": 900, "stage": "epoch 7/16", "metrics": {"loss": 0.31}}`
- Terminal states: `succeeded | failed | cancelled` with exit evidence (metrics files, logs, error).
- Jobs that cannot estimate progress still emit stage transitions; the dashboard degrades gracefully.

**Agent observability:** the supervisor publishes every agent-session event (tool calls, messages, model usage) to the same event bus, so the dashboard's activity feed shows agents and jobs uniformly.

---

## 7. Dashboard v1

- **Ops view:** live job progress/ETA, runner/node health, agent activity feed (SSE).
- **Approval inbox:** plan approvals, substantial-change requests, escalations, gate-audit summaries — as structured forms with context links.
- **Ad hoc chat:** talk to any agent role (or a fresh session) about ongoing work; backed by pi sessions via the supervisor's chat bridge.
- Single-user, token auth. DAG visualization: future.

---

## 8. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Audits become rubber stamps | Evidence is a first-class job output (metrics, seeds, env pins); auditor checks are skill-driven and versioned |
| Agent-edited skills drift/inject | Skills live in git; director approval required; optional worktree A/B on identical inputs |
| Pull-only cancellation latency | Leases + heartbeats with tunable poll interval; cancellation flag honored at next poll; hard timeout re-queues |
| HF/git lineage gaps | Artifact registry rows record git commit + HF revision together; librarian indexes both |
| "More capable model" undefined | Model-tier registry in per-project config is the single source of capability ordering |
| GPU contention (inference vs training) | Compose quotas; heavy campaigns prefer nodes without resident model servers; documented soft-limit caveat |
| Public repo leaks secrets | Secrets only in hub `.env`; demo uses no credentials; CI checks |
| Stack-agnostic boilerplate tax on early projects | Starter skills + job-protocol helper scripts in project templates (demo project demonstrates the pattern) |
| Community-package churn | Purpose-built extensions own the core; community packages are additive and swappable |

---

## 9. Phased rollout

1. **P0 — Protocols & demo scaffold (this session):** design doc, PLAN.md, demo project (simulated, no GPU).
2. **P1 — Job plane:** hub API + Postgres + SSE, runner, job protocol v0, two simulated spokes. *Demo jobs run end-to-end.*
3. **P2 — Governance plane:** planning-graph engine, gates, director + worker + auditor agents, approval inbox.
4. **P3 — Experience:** dashboard ops view + chat bridge; reflector + librarian.
5. **P4 — Real compute:** first real GPU campaign on the 5090; Spark joins as second spoke; LiteLLM + tier config against real models.

---

## 10. Open design questions (intentionally deferred)

- Exact job-protocol/event JSON schemas (P1; demo locks the v0 shape).
- Postgres schema details; SSE event envelope; lease/heartbeat parameters.
- Chat-session bridge mechanics (which sessions are chat-addressable; history policy).
- Model-tier registry format; per-project config schema.
- Community-package shortlist & evaluation criteria (workstream in PLAN.md).
- Demo project's concrete research question (authored in the demo scaffold; simulated).
