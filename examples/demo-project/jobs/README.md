# Demo jobs & the job protocol

Both jobs (`simulate_training.py`, `analyze_results.py`) are **simulated, stdlib-only Python** — proof that the framework's job protocol is stack-agnostic (DESIGN.md §6). Real projects swap job bodies; the contract below stays.

## The contract each job satisfies

1. **Progress stream** — append JSON lines to `progress.jsonl` in the job's output dir:
   ```json
   {"t": 1.23, "pct": 42.0, "eta_s": 61.7, "stage": "step 84/200", "metrics": {"loss": 0.51}}
   ```
   - `pct` monotonic 0–100; `eta_s` best-effort; `stage` human-readable; `metrics` free-form key/values.
   - Terminal line adds `"state": "succeeded"` or `"failed"`.

2. **First-class evidence** — `metrics.json` with reproducibility fields (`seed`, `config_hash`) plus the quantities a gate will check (`final_loss`). Gate verification reads this file; claims without evidence fail gates.

3. **Exit code semantics** — 0 iff `state == succeeded`.

4. **No protocol dependencies** — jobs never import framework code. When PLAN.md M1 lands, `protocols/emit/{py,sh}` helpers will make the emitter one import instead of 8 lines; these scripts remain the dependency-free reference.

## Sabotage flag

`--sabotage plateau` produces a run whose loss never improves. Its gate (`repair-demo-gate` in `plan/graph.yaml`) **will fail**, demonstrating the repair loop. A demo where nothing fails validates nothing.
