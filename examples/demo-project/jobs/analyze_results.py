#!/usr/bin/env python3
"""Simulated analysis job — demo-project (SIMULATION ONLY).

Reads the evidence (metrics.json) produced by training runs, compares
convergence, and writes the artifacts the analysis-gate checks:
  <out>/summary.md        — comparative findings with effect sizes
  <out>/retrospective.md  — worker exit requirement (DESIGN.md §5.2)

Protocol conformance: same progress.jsonl contract as training jobs;
exit code non-zero when evidence is missing or invalid — that is what
the auditor (and the demo's repair path) keys off.
"""
import argparse
import json
import os
import time


def emit(out_dir, event):
    with open(os.path.join(out_dir, "progress.jsonl"), "a") as f:
        f.write(json.dumps(event) + "\n")


def load_evidence(run_dir):
    path = os.path.join(run_dir, "metrics.json")
    if not os.path.exists(path):
        raise SystemExit(f"[analyze_results] missing evidence: {path}")
    with open(path) as f:
        m = json.load(f)
    for key in ("variant", "seed", "config_hash", "final_loss"):
        if key not in m:
            raise SystemExit(f"[analyze_results] invalid evidence in {path}: missing {key!r}")
    if m.get("succeeded") is False:
        # Evidence from a FAILED run must not feed conclusions — this is the
        # evidence-first rule the auditor enforces (skills/auditor/SKILL.md).
        raise SystemExit(f"[analyze_results] refusing failed evidence in {path}: "
                         f"variant={m['variant']} final_loss={m['final_loss']}")
    return m


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", nargs="+", required=True, help="run dirs containing metrics.json")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    t0 = time.time()

    emit(args.out, {"t": 0.0, "pct": 10, "eta_s": 2, "stage": "loading evidence", "metrics": {}})
    runs = [load_evidence(d) for d in args.runs]

    emit(args.out, {"t": round(time.time() - t0, 2), "pct": 50, "eta_s": 1,
                    "stage": "comparing", "metrics": {}})
    base = next((r for r in runs if r["variant"] == "baseline"), None)
    comparisons = []
    for r in runs:
        if r is base:
            continue
        delta = base["final_loss"] - r["final_loss"]
        rel = delta / base["final_loss"]
        comparisons.append((base["label"], r["label"], delta, rel))
        time.sleep(0.02)

    with open(os.path.join(args.out, "summary.md"), "w") as f:
        f.write("# Convergence comparison (SIMULATED)\n\n")
        f.write("| comparison | final_loss delta | relative |\n|---|---|---|\n")
        for a, b, d, rel in comparisons:
            f.write(f"| {a} vs {b} | {d:+.4f} | {rel:+.1%} |\n")
        f.write("\nPositive delta = variant reached lower loss than baseline.\n")
        f.write("\nNOTE: synthetic data; conclusions are plumbing-validation only.\n")

    with open(os.path.join(args.out, "retrospective.md"), "w") as f:
        f.write("# Worker retrospective — analysis activity\n\n")
        f.write("- What worked: evidence files were present and mechanically checkable.\n")
        f.write("- What was fragile: analysis assumed every run dir had metrics.json; "
                "missing evidence fails the whole job rather than degrading.\n")
        f.write("- Lesson proposed: training jobs should always write metrics.json "
                "even on failure (partial evidence beats none).\n")

    emit(args.out, {"t": round(time.time() - t0, 2), "pct": 100.0, "eta_s": 0,
                    "stage": "done", "metrics": {"comparisons": len(comparisons)},
                    "state": "succeeded"})
    print(f"[analyze_results] {len(comparisons)} comparisons -> {args.out}/summary.md")


if __name__ == "__main__":
    main()
