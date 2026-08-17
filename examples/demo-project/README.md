# Demo Project — "Curriculum Effects" (simulated)

**The 1-hour quick-start for the Pi Autoresearch Lab.** This project doubles as (a) the canonical example of a *research project repo* and (b) the framework's first end-to-end **validation scenario** — a full smoke test of the job protocol, planning graph, gates, approvals, and observability using **simulated jobs (no GPU, no real training)**.

> **Research fiction (on purpose):** the "experiments" below simulate training runs with synthetic loss curves. The science is fake; the *plumbing* is real. When the framework core (PLAN.md M1–M3) is implemented, this same graph runs unmodified against real or simulated compute.

---

## What you'll validate

By the end you will have exercised every protocol the framework defines:

1. **Job protocol** — simulated jobs emit standard progress/ETA events and first-class evidence.
2. **Planning graph** — a goal → DAG of activities → exit gates, reviewed before execution.
3. **Governance** — human approves the plan; auditor verifies gates; a repair loop fires.
4. **Observability** — everything above is visible as it happens (standalone now; dashboard at M6).

---

## Layout

```
examples/demo-project/
├── README.md            ← you are here
├── goal.md              ← the research goal (human-approved by definition)
├── plan/
│   └── graph.yaml       ← planning graph: activities, dependencies, exit gates
├── jobs/
│   ├── simulate_training.py   ← simulated training run (protocol-conformant)
│   ├── analyze_results.py     ← simulated analysis job (protocol-conformant)
│   └── README.md        ← how these jobs satisfy the protocol
├── skills/              ← agent skills, versioned in this repo
│   ├── worker-researcher/SKILL.md
│   ├── auditor/SKILL.md
│   ├── reflector/SKILL.md
│   └── librarian/SKILL.md
├── config/
│   └── project.yaml     ← per-project config: model tiers, role→model mapping
└── runs/                ← worktrees + outputs (created at runtime; gitignored)
```

---

## Quick-start walkthrough (~60 min)

### Part A — Explore the research definition (10 min)

1. Read `goal.md` — note it is the only human-authored, human-approved artifact by definition.
2. Read `plan/graph.yaml` — find the four activities (`baseline`, `variant-a`, `variant-b`, `analysis`), the DAG edges, and each activity's **exit gate** with checkable criteria and evidence pointers.
3. Read `config/project.yaml` — see the model-tier registry and role→tier mapping this project would use.

### Part B — Run jobs standalone against the protocol (20 min)

The demo jobs are runnable **today**, with zero infrastructure — Python 3.9+ only:

```bash
cd examples/demo-project

# Simulated training: baseline (fast-forward demo speed)
python jobs/simulate_training.py --variant baseline --steps 200 --out runs/baseline

# Watch it again and tail the progress stream in a second terminal:
python jobs/simulate_training.py --variant variant-a --steps 200 --out runs/variant-a &
tail -f runs/variant-a/progress.jsonl

# The analysis job consumes the evidence from all three runs:
python jobs/analyze_results.py --runs runs/baseline runs/variant-a runs/variant-b --out runs/analysis
```

> If `variant-b` hasn't run yet, run it first: `python jobs/simulate_training.py --variant variant-b --steps 200 --out runs/variant-b`

**Check yourself:**
- `runs/baseline/progress.jsonl` contains JSON lines with `t`, `pct`, `eta_s`, `stage`, `metrics` — this is the progress contract from DESIGN.md §6.
- `runs/baseline/metrics.json` exists — this is the **evidence** the auditor's gate check reads.
- Exit code is `0` and the final progress line has `"state": "succeeded"`.

### Part C — Exercise the failure path (10 min)

```bash
# Sabotage: a run whose loss curve never improves → gate criteria will fail
python jobs/simulate_training.py --variant baseline --steps 200 --out runs/bad --sabotage plateau
python jobs/analyze_results.py --runs runs/bad --out runs/bad-analysis || echo "analysis exited non-zero: expected"
```

This is the artifact shape the **auditor** would reject at the `baseline-gate` (criteria: `final_loss < 0.5`), sending work back to the worker for **repair** — the governance loop from DESIGN.md §5.2.

### Part D — Trace the governance story (10 min)

1. Open `skills/auditor/SKILL.md` — see exactly how the auditor evaluates `baseline-gate` (read `metrics.json`, verify criteria, check evidence is *reasonable*, not just present).
2. Open `skills/worker-researcher/SKILL.md` — see the retrospective template every worker fills at exit.
3. Open `skills/reflector/SKILL.md` — see how retrospectives + audit anomalies become skill/plan proposals.

### Part E — Full stack (deployed framework, ~10 min)

The framework deploys via docker-compose (see repo `DESIGN.md` §4):

```bash
# one-time: framework repo + model weights + env
git clone <framework-repo> && cd <framework-repo>
./scripts/fetch-models.sh                     # 15.8 GB local auditor model (optional)
cp .env.example .env                          # fill Z_AI_API_KEY (director agent)

# deploy: hub + postgres + two spokes (+ local vLLM when weights present)
docker compose up -d postgres hub
docker compose --profile spoke up -d
docker compose --profile local-llm up -d vllm   # optional local auditor model

open http://localhost:8080                     # dashboard: ops view + approvals
```

Then submit the demo plan and drive it end-to-end (submission, approval, both
spokes pulling work, gates, repair, escalation, agent notes):

```bash
node scripts/e2e-demo.mjs http://localhost:8080
```

You should see (in the dashboard and the e2e output): plan approval **blocking
execution** until approved → jobs scheduled across two spokes → live progress/ETA
→ gates audited → the deliberate `repair-demo` gate fails, repairs, and
**escalates** with a director recommendation → operator resolves → plan done,
with auditor notes attached to every gate result.

Without the optional vLLM profile, the same flow runs with agents disabled
(set `AUDITOR_MODEL`/`DIRECTOR_MODEL` to a remote provider in `.env` to keep
agents on instead).

---

## Design notes (why this demo looks like this)

- **Simulated, dependency-free jobs** prove the protocol is *stack-agnostic*: nothing here imports ML frameworks. Real projects replace job bodies; the contract stays.
- **Evidence-first:** every job writes `metrics.json` before claiming success — auditor checks are mechanical, not vibes.
- **The sabotage path is intentional:** a demo where nothing fails validates nothing about repair loops.
- **Skills are content, not code:** they demonstrate that research know-how lives in versioned repo artifacts the reflector can evolve.

## Troubleshooting

- `python3: command not found` → use `python3`; scripts are stdlib-only.
- `analyze_results.py: missing runs/variant-b` → run the variant-b training first (Part B).
- Port conflicts in Part E → hub port is configurable in `.env`.
