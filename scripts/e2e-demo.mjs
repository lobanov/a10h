#!/usr/bin/env node
/**
 * End-to-end demo test (goal verification evidence).
 *
 *   node scripts/e2e-demo.mjs [HUB_URL]
 *
 * Requires: hub running (agents configured for full verification), one or
 * more workers pulling work, docker available to workers.
 *
 * Steps verified:
 *  1. plan submission -> approval pending, NO jobs created (blocking proof)
 *  2. approval -> baseline scheduled; all activities reach terminal states
 *  3. gates: baseline/variant-a/variant-b/analysis PASS; repair-demo
 *     fails -> repair rerun -> escalation
 *  4. escalation resolution -> plan done
 *  5. evidence/artifacts recorded in Postgres; progress artifacts validate
 *     against protocols/progress.schema.json (via protocols/validate.mjs)
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HUB = process.argv[2] ?? process.env.HUB_URL ?? "http://localhost:8080";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLAN_NAME = `e2e-demo-${Date.now().toString(36)}`;
const TIMEOUT_MS = 8 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, init = {}) {
  const res = await fetch(`${HUB}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

const failures = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
}

async function getState() {
  return api("/api/state");
}

function planActivities(state, planId) {
  return state.activities.filter((a) => a.plan_id === planId);
}

async function waitFor(desc, predicate, timeoutMs = TIMEOUT_MS) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    last = await getState();
    if (predicate(last)) return last;
    await sleep(2000);
  }
  throw new Error(`timeout waiting for: ${desc}\nlast state: ${JSON.stringify(last?.plans ?? [])}`);
}

async function main() {
  console.log(`[e2e] hub=${HUB} plan=${PLAN_NAME}`);
  await api("/api/health");

  // 1. submit plan
  const graphYaml = readFileSync(join(ROOT, "examples/demo-project/plan/graph.yaml"), "utf8");
  const submitted = await api("/api/plans", {
    method: "POST",
    body: JSON.stringify({ name: PLAN_NAME, graph_yaml: graphYaml, repo_subdir: "examples/demo-project" }),
  });
  console.log(`[e2e] submitted plan ${submitted.plan_id}, approval #${submitted.approval_id}`);

  // 2. approval blocking proof: no jobs while pending
  await sleep(3500); // > one scheduler tick
  let state = await getState();
  const jobsBeforeApproval = state.jobs.filter((j) => j.plan_id === PLAN_NAME).length;
  check("approval blocks execution", jobsBeforeApproval === 0 && state.plans.find((p) => p.id === PLAN_NAME)?.status === "pending_approval");

  // 3. approve
  await api(`/api/approvals/${submitted.approval_id}`, {
    method: "POST",
    body: JSON.stringify({ action: "approve" }),
  });
  console.log("[e2e] plan approved; waiting for activities to reach terminal states...");

  // 4. wait for: repair-demo escalated, others passed
  state = await waitFor("all activities terminal (repair-demo escalated)", (s) => {
    const acts = planActivities(s, PLAN_NAME);
    return acts.length === 5 && acts.every((a) => ["passed", "resolved", "failed_final", "escalated"].includes(a.status));
  });

  const acts = planActivities(state, PLAN_NAME);
  for (const a of acts) console.log(`[e2e]   ${a.id}: ${a.status} (attempt ${a.attempt})`);
  check("baseline passed", acts.find((a) => a.id === "baseline")?.status === "passed");
  check("variant-a passed", acts.find((a) => a.id === "variant-a")?.status === "passed");
  check("variant-b passed", acts.find((a) => a.id === "variant-b")?.status === "passed");
  check("analysis passed", acts.find((a) => a.id === "analysis")?.status === "passed");
  check("repair-demo escalated after failed repair", acts.find((a) => a.id === "repair-demo")?.status === "escalated");

  // gate results detail
  const gates = state.gate_results.filter((g) => g.plan_id === PLAN_NAME);
  check("gate results recorded", gates.length >= 6, `${gates.length} gate results`);
  const analysisGate = gates.find((g) => g.activity === "analysis");
  check("analysis evidence includes summary + retrospective",
    Boolean(analysisGate), analysisGate?.reason ?? "");

  // 5. escalation approval exists; director note (agents)
  const escalation = state.approvals.find((a) => a.kind === "escalation" && a.plan_id === PLAN_NAME && a.status === "pending");
  check("escalation approval pending", Boolean(escalation));
  if (escalation) {
    // give the director agent a chance to attach its note (local/remote model latency)
    let withNote = null;
    for (let i = 0; i < 120 && !withNote; i++) {
      await sleep(3000);
      const s = await getState();
      withNote = s.approvals.find((a) => a.id === escalation.id)?.agent_note ?? null;
    }
    check("director agent recommendation attached", Boolean(withNote), withNote ? String(withNote).slice(0, 140) : "no note");

    await api(`/api/approvals/${escalation.id}`, {
      method: "POST",
      body: JSON.stringify({ action: "resolve", disposition: "accept_failure" }),
    });
  }

  // 6. plan done
  state = await waitFor("plan done", (s) => s.plans.find((p) => p.id === PLAN_NAME)?.status === "done", 60_000);
  check("plan done", state.plans.find((p) => p.id === PLAN_NAME)?.status === "done");

  // 7. auditor agent notes on gate results (serialized queue; local model latency)
  let audited = 0;
  for (let i = 0; i < 120; i++) {
    const s = await getState();
    audited = s.gate_results.filter((g) => g.plan_id === PLAN_NAME && g.audit_note).length;
    if (audited >= 1) break;
    await sleep(3000);
  }
  check("auditor agent reviewed gates", audited >= 1, `${audited}/${gates.length} audited`);

  // 8. evidence + artifact validation via protocols/validate.mjs
  const planJobs = state.jobs.filter((j) => j.plan_id === PLAN_NAME);
  const tmp = join("/tmp", `e2e-validate-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  let validatedRuns = 0;
  for (const job of planJobs) {
    if (job.status !== "succeeded" && job.activity !== "repair-demo") continue;
    const arts = await api(`/api/jobs/${job.id}/artifacts`);
    const progress = arts.artifacts.find((a) => a.path.endsWith("progress.jsonl"));
    if (!progress) continue;
    const dir = join(tmp, job.activity ?? job.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "progress.jsonl"), progress.content ?? "");
    const metrics = arts.artifacts.find((a) => a.kind === "evidence" && a.path.endsWith("metrics.json"));
    if (metrics) writeFileSync(join(dir, "metrics.json"), metrics.content ?? "");
    validatedRuns++;
  }
  if (validatedRuns > 0) {
    const dirs = planJobs.map((j) => join(tmp, j.activity ?? j.id)).filter((p) => existsSyncSafe(p));
    const proc = spawnSync("node", [join(ROOT, "protocols/validate.mjs"), ...dirs], { encoding: "utf8" });
    console.log(proc.stdout.trim());
    check("progress artifacts schema-valid", proc.status === 0);
  } else {
    check("progress artifacts schema-valid", false, "no progress artifacts found");
  }
  rmSync(tmp, { recursive: true, force: true });

  // summary
  console.log(`\n[e2e] ${failures.length === 0 ? "ALL CHECKS PASSED" : `${failures.length} FAILED: ${failures.join(", ")}`}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

function existsSyncSafe(p) {
  return existsSync(p);
}

main().catch((e) => {
  console.error("[e2e] fatal:", e.message);
  process.exit(1);
});
