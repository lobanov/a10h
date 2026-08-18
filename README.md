# Pi Autoresearch Lab

A multi-agent research lab built on the [Pi coding agent](https://pi.dev): agents plan, run, verify, and reflect on experimental AI-architecture research across local GPUs (RTX 5090, DGX Spark) and remote LLM APIs — with a human operator supervising through a web dashboard.

> **Status:** R1–R7 implemented and validated (git plane, SSE worker-agent protocol, secretary agent, demo seeding + validation rework). See [PLAN.md](PLAN.md).

## What it is

- **Framework repo (this repo):** docker-compose stack (hub supervisor, Postgres, dashboard, gitserver, hf store; optional LiteLLM) + workers that register over TLS and receive work as SSE instructions (one task per container; the research repo is served by the hub over HTTPS with per-worker tokens). `git clone && docker-compose up` bootstraps the lab.
- **Research project repos:** your actual research — goal, planning graph (activities + exit gates), experiment code, agent skills, artifacts (git + HuggingFace). See [examples/demo-project/](examples/demo-project/).
- **Agent hierarchy:** director (plans, never executes), workers, secretary (work handoff, formal gate verification, retention, indices/lineage), reflector (proposes plan/skill changes) — all pi agent sessions, governed by the approval + escalation flows in [DESIGN.md](DESIGN.md#5-agent-roster--governance).

## Documentation

| Doc | What's in it |
|---|---|
| [DESIGN.md](DESIGN.md) | Architecture, protocols, governance, risks, rollout |
| [PLAN.md](PLAN.md) | Implementation tasklist: milestones M0–M10, P4 |
| [examples/demo-project/](examples/demo-project/) | **Quick-start** (~1h, no GPU): simulated research project validating the protocols |

## Quick-start (simulated, no GPU)

```bash
cd examples/demo-project
python3 jobs/simulate_training.py --variant baseline --steps 200 --out runs/baseline
python3 jobs/simulate_training.py --variant variant-a --steps 200 --out runs/variant-a
python3 jobs/simulate_training.py --variant variant-b --steps 200 --out runs/variant-b
python3 jobs/analyze_results.py --runs runs/baseline runs/variant-a runs/variant-b --out runs/analysis
```

Then follow the full walkthrough: [examples/demo-project/README.md](examples/demo-project/README.md).

## License

TBD (M0 in [PLAN.md](PLAN.md)).
