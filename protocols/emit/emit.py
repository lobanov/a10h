#!/usr/bin/env python3
"""Dependency-free progress emitter for job authors (protocol v0).

Usage:
    from emit import Emitter                     # same dir, or copy the file
    em = Emitter(out_dir=".")
    em.progress(pct=42, eta_s=61, stage="epoch 7/16", metrics={"loss": 0.31})
    em.done(succeeded=True, metrics={"loss": 0.20})

Writes progress.jsonl per protocols/progress.schema.json.
Stdlib only — jobs never depend on framework code.
"""
import json
import os
import time


class Emitter:
    def __init__(self, out_dir=".", clock=time.time):
        self._path = os.path.join(out_dir, "progress.jsonl")
        self._t0 = clock()

    def _write(self, payload):
        with open(self._path, "a") as f:
            f.write(json.dumps(payload) + "\n")

    def progress(self, pct, stage, eta_s=None, metrics=None):
        ev = {"t": round(time.time() - self._t0, 2), "pct": float(pct), "stage": str(stage)}
        if eta_s is not None:
            ev["eta_s"] = float(eta_s)
        if metrics:
            ev["metrics"] = metrics
        self._write(ev)

    def done(self, succeeded, metrics=None):
        ev = {"t": round(time.time() - self._t0, 2), "pct": 100.0, "eta_s": 0, "stage": "done"}
        if metrics:
            ev["metrics"] = metrics
        ev["state"] = "succeeded" if succeeded else "failed"
        self._write(ev)
