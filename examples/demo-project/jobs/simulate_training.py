#!/usr/bin/env python3
"""Simulated training job — demo-project (SIMULATION ONLY).

Conforms to the framework job protocol (DESIGN.md §6):
  * emits progress events as JSON lines to <out>/progress.jsonl
    {t, pct, eta_s, stage, metrics}
  * terminal event carries {"state": "succeeded"|"failed"}
  * writes first-class evidence to <out>/metrics.json
    (seed + config hash + final_loss) for auditor gate checks
  * exit code 0 iff succeeded

Stdlib-only: proves the protocol is stack-agnostic. A real project would
swap the synthetic loss curve for actual training and keep the contract.
"""
import argparse
import hashlib
import json
import math
import os
import random
import time

VARIANTS = {
    # (start_loss, floor, decay): synthetic convergence profiles
    "baseline":  dict(start=2.0, floor=0.18, decay=0.022, label="uniform sampling"),
    "variant-a": dict(start=2.0, floor=0.12, decay=0.030, label="curriculum easy->hard"),
    "variant-b": dict(start=2.0, floor=0.28, decay=0.018, label="curriculum hard->easy (control)"),
}


def emit(out_dir, event):
    with open(os.path.join(out_dir, "progress.jsonl"), "a") as f:
        f.write(json.dumps(event) + "\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--variant", required=True, choices=sorted(VARIANTS))
    ap.add_argument("--steps", type=int, default=200)
    ap.add_argument("--out", required=True)
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--sabotage", choices=["plateau"], help="force a failing run (demo repair loop)")
    args = ap.parse_args()

    cfg = VARIANTS[args.variant]
    seed = args.seed if args.seed is not None else 1337
    rng = random.Random(seed)
    os.makedirs(args.out, exist_ok=True)
    t0 = time.time()

    spec = {"variant": args.variant, "steps": args.steps, "seed": seed}
    config_hash = hashlib.sha256(json.dumps(spec, sort_keys=True).encode()).hexdigest()[:12]

    for step in range(1, args.steps + 1):
        loss = cfg["floor"] + (cfg["start"] - cfg["floor"]) * math.exp(-cfg["decay"] * step)
        loss *= 1.0 + rng.gauss(0, 0.03)
        if args.sabotage == "plateau":
            loss = max(loss, 1.4)  # never improves past the gate threshold
        elapsed = time.time() - t0
        pct = round(100.0 * step / args.steps, 1)
        eta_s = round(elapsed / step * (args.steps - step), 1)
        emit(args.out, {
            "t": round(elapsed, 2), "pct": pct, "eta_s": eta_s,
            "stage": f"step {step}/{args.steps}",
            "metrics": {"loss": round(loss, 4)},
        })
        time.sleep(0.005)  # keep the demo fast but visible

    final_loss = round(loss, 4)
    succeeded = not (args.sabotage == "plateau")

    with open(os.path.join(args.out, "metrics.json"), "w") as f:
        json.dump({
            "variant": args.variant, "label": cfg["label"], "seed": seed,
            "config_hash": config_hash, "steps": args.steps,
            "final_loss": final_loss, "succeeded": succeeded,
        }, f, indent=2)

    emit(args.out, {"t": round(time.time() - t0, 2), "pct": 100.0, "eta_s": 0,
                    "stage": "done", "metrics": {"loss": final_loss},
                    "state": "succeeded" if succeeded else "failed"})
    print(f"[simulate_training] variant={args.variant} final_loss={final_loss} "
          f"state={'succeeded' if succeeded else 'failed'}")
    raise SystemExit(0 if succeeded else 1)


if __name__ == "__main__":
    main()
