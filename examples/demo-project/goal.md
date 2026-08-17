# Research Goal — Curriculum Effects on Convergence (SIMULATED)

> **Status:** APPROVED (human-authored goals are approved by definition — DESIGN.md §5.2)
> **Simulation notice:** This is the framework's validation scenario. The "training" is synthetic; conclusions are not real science. Replace this file, the plan, and the jobs to run real research.

## Goal statement

Determine whether a difficulty-ordered curriculum (easy→hard) improves convergence speed over uniform sampling on our synthetic task, at matched compute budget.

## Success looks like

1. Baseline and both curriculum variants trained under identical budgets with reproducible evidence (seeds, configs, metrics files).
2. A comparative analysis artifact stating which curriculum (if any) converged faster, with effect sizes and uncertainty.
3. Every activity's exit gate verified as *evidenced and reasonable* — not merely completed.

## Constraints

- v1 of this project runs **simulated** training (no GPU required).
- All artifacts durable in this repo; any large artifacts (none expected) go to HuggingFace with lineage recorded.

## Out of scope

- Real model training, hyperparameter realism, publishable claims.
