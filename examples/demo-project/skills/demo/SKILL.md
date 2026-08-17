---
name: demo
description: Execute the demo project's activities — run the simulated training/analysis jobs, produce gate-passing evidence, exit with a retrospective. Task-specific skill for the demo's tasks; used by worker agents assigned to demo activities.
---

# Demo task execution

You are a worker executing ONE activity from `plan/graph.yaml` in this repo (the demo project). This skill covers what the demo's tasks actually do and what a passing exit looks like. Governance rules: DESIGN.md §5.2.

## The two jobs in this repo

1. **`jobs/simulate_training.py`** — simulated training run. Writes `metrics.json` (`variant`, `seed`, `config_hash`, `final_loss`, `succeeded`) and `progress.jsonl` under `--out`. Flags: `--variant baseline|variant-a|variant-b`, `--steps`, `--out runs/<activity>`, `--sabotage plateau|diverge` (demo-only: forces a failing run to exercise the repair loop).
2. **`jobs/analyze_results.py`** — reads one or more `--runs` dirs, validates their `metrics.json`, writes an analysis report to `--out`. Exits non-zero on missing/failed evidence — by design.

Run `<script> --help` for the full contract; `plan/graph.yaml` is the source of truth for which activity runs what.

## Evidence the gate checks

For `baseline` the `baseline-gate` requires (mechanically, from `plan/graph.yaml`):
- job state `succeeded`
- `metrics.json` → `final_loss < 0.5`
- `metrics.json` → `seed` and `config_hash` present

**Verify evidence before claiming anything.** The gate reads files, not your summary. If `metrics.json` is missing or shows a failed/sabotaged run, you are not done — and never edit metrics to pass; a run you know will fail goes through the repair/escalation path instead.

## Workflow

1. Read your activity's spec in `plan/graph.yaml` (title, job command, gate criteria, expected outputs).
2. Run the job; write outputs under `runs/<activity>/`. Monitor `progress.jsonl`; if `eta_s` balloons or a stage stalls, investigate before the timeout kills it.
3. Check the gate criteria yourself against the files on disk.
4. Push your work to your **task branch** (DESIGN.md §3.2.1) and submit the exit bundle: artifacts named in the activity spec + `retrospective.md`.

## Retrospective (mandatory at exit)

```markdown
# Worker retrospective — <activity>
- What worked: <thing that sped you up or avoided a failure>
- What was fragile: <thing that almost broke or wasted time>
- Lesson proposed: <concrete change to a skill, plan pattern, or job template>
```

(The prompt arrives as an instruction from the hub; this is the shape of the answer.)

## Repair loop

When the gate/secretary verification fails you, you receive the verification findings. Fix the specific deficiency, re-run what's needed, and re-submit on the same branch. Two failed repairs on the same deficiency → escalate:

> ESCALATE: task unachievable as planned. Reason: <specific blocker>. Evidence: <links>.
