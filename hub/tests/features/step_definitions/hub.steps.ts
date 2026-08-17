/**
 * Hub BDD steps. Runs against a scratch Postgres database and an ephemeral
 * in-process hub server (real API + scheduler + gate engine, no docker).
 *
 * Requires: local Postgres on localhost:5432 (docker compose up -d postgres
 * exposes it).
 */
import { After, AfterAll, BeforeAll, Given, Then, When } from "@cucumber/cucumber";
import pg from "pg";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

let baseURL = "";
let hubMod: any;
let server: any;
let scratchDb = "";
let lastResponse: Response | null = null;
let pulled: Record<string, unknown | null> = {};
let planName = "";
let reposDir = "";
let seedWt = "";
let tokens: Record<string, string> = {};

const PLAN_GRAPH = `goal_ref: goal.md
activities:
  alpha:
    title: alpha
    depends_on: []
    job: {image: "python:3.12-slim", command: ["true"], requirements: {cpu: 1}, outputs: {evidence: ["runs/x/metrics.json"]}}
    exit_gate:
      id: alpha-gate
      criteria:
        - {id: exit_ok, check: {type: job_state, equals: succeeded}}
        - {id: loss_below, check: {type: evidence_json, file: metrics.json, field: final_loss, op: lt, value: 0.5}}
  beta:
    title: beta
    depends_on: [alpha]
    job: {image: "python:3.12-slim", command: ["true"]}
`;

const CYCLIC_GRAPH = `goal_ref: goal.md
activities:
  a:
    depends_on: [b]
    job: {image: "python:3.12-slim", command: ["true"]}
  b:
    depends_on: [a]
    job: {image: "python:3.12-slim", command: ["true"]}
`;

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${baseURL}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

async function state(): Promise<any> {
  const res = await api("/api/state");
  assert.ok(res.ok, `state failed: ${res.status}`);
  return res.json();
}

BeforeAll(async function () {
  // Scratch database, created before hub modules import (db.ts reads env).
  scratchDb = `ar_bdd_${Date.now().toString(36)}`;
  const admin = new pg.Client({
    host: process.env.PGHOST ?? "localhost",
    port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER ?? "autoresearch",
    password: process.env.PGPASSWORD ?? "autoresearch-dev",
    database: "postgres",
  });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${scratchDb}`);
  await admin.end();
  process.env.PGDATABASE = scratchDb;
  process.env.Z_AI_API_KEY = ""; // keep agents disabled for determinism
  process.env.LOCAL_LLM_BASE_URL = "";

  // R2 git-plane fixture: a scratch REPOS_DIR with a demo.git bare repo
  // (one commit on main), set BEFORE hub modules import (gitsvc reads env).
  reposDir = mkdtempSync(join(tmpdir(), "ar-bdd-repos-"));
  process.env.REPOS_DIR = reposDir;
  seedWt = mkdtempSync(join(tmpdir(), "ar-bdd-seed-"));
  const g = (args: string[]) =>
    execFileSync("git", args, { encoding: "utf8", cwd: seedWt });
  g(["init", "-q", "-b", "main"]);
  execFileSync("bash", ["-c", `cd '${seedWt}' && echo demo > goal.md && git add -A && ` +
    `git -c user.name=bdd -c user.email=bdd@local commit -q -m 'seed'`]);
  execFileSync("bash", ["-c", `git clone -q --bare '${seedWt}' '${join(reposDir, "demo.git")}'`]);
  // Real worker tokens from the bootstrap-generated policy map (if present).
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
  const policyPath = join(repoRoot, "data/git/policy.json");
  try {
    const policy = JSON.parse(readFileSync(policyPath, "utf8"));
    process.env.POLICY_PATH = policyPath; // hub-side token lookups in BDD
    tokens = Object.entries(policy.tokens).reduce<Record<string, string>>((acc, [tok, info]) => {
      acc[(info as { node: string }).node] = tok;
      return acc;
    }, {});
  } catch { /* no policy map — token steps will fail loudly */ }

  hubMod = await import("../../../src/index-export.ts");
  await hubMod.migrate();
  server = hubMod.createHttpServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  baseURL = `http://127.0.0.1:${server.address().port}`;
});

After(async function () {
  // Scenario isolation: scratch DB is shared; wipe mutable tables between scenarios.
  await hubMod.pool.query(
    "TRUNCATE nodes, jobs, job_events, artifacts, plans, activities, gate_results, approvals, agent_log, git_force_auth, rebase_instructions",
  );
  // Git fixture state drifts between scenarios (branches land on main).
  // Re-seed demo.git so each scenario starts from a single-commit main.
  execFileSync("bash", ["-c", `rm -rf '${join(reposDir, "demo.git")}' && git clone -q --bare '${seedWt}' '${join(reposDir, "demo.git")}'`]);
  lastResponse = null;
  pulled = {};
});

AfterAll(async function () {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await hubMod.pool.end();
  rmSync(reposDir, { recursive: true, force: true });
  rmSync(seedWt, { recursive: true, force: true });
  const admin = new pg.Client({
    host: process.env.PGHOST ?? "localhost",
    port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER ?? "autoresearch",
    password: process.env.PGPASSWORD ?? "autoresearch-dev",
    database: "postgres",
  });
  await admin.connect();
  await admin.query(`DROP DATABASE ${scratchDb}`);
  await admin.end();
});

// ---------- job plane ----------

Given("a queued job {string}", async function (jobId: string) {
  const res = await api("/api/jobs", {
    method: "POST",
    body: JSON.stringify({ id: jobId, image: "python:3.12-slim", command: ["true"] }),
  });
  assert.equal(res.status, 201);
});

When("I GET {string}", async function (path: string) {
  lastResponse = await api(path);
});

When("the worker posts a progress event with pct {int}", async function (pct: number) {
  lastResponse = await api("/api/jobs/t-invalid/events", {
    method: "POST",
    body: JSON.stringify({ t: 1, pct, stage: "x" }),
  });
});

Then("the response status is {int}", function (status: number) {
  assert.equal(lastResponse!.status, status);
});

Then("the response body field {string} is {string}", async function (field: string, value: string) {
  const body = (await lastResponse!.json()) as Record<string, unknown>;
  assert.equal(String(body[field]), value);
});

Then("the response body field {string} is the boolean true", async function (field: string) {
  const body = (await lastResponse!.json()) as Record<string, unknown>;
  assert.equal(body[field], true);
});

When("worker {string} pulls work", async function (worker: string) {
  const res = await api(`/api/work?node=${worker}`);
  pulled[worker] = res.status === 200 ? await res.json() : null;
});

Then("worker {string} receives job {string}", function (worker: string, jobId: string) {
  assert.equal((pulled[worker] as any)?.id, jobId);
});

Then("worker {string} receives no job", function (worker: string) {
  assert.equal(pulled[worker], null);
});

// ---------- plan governance ----------

Given("a plan graph with gated activity {string} and dependent {string}", function (_alpha: string, _beta: string) {
  planName = `bdd-${Date.now().toString(36)}`;
});

async function submitPlan(graphYaml: string): Promise<Response> {
  return api("/api/plans", {
    method: "POST",
    body: JSON.stringify({ name: planName, graph_yaml: graphYaml }),
  });
}

Given("the plan is submitted", async function () {
  const res = await submitPlan(PLAN_GRAPH);
  assert.equal(res.status, 201);
  lastResponse = res;
});

Given("the plan is submitted and approved", async function () {
  const res = await submitPlan(PLAN_GRAPH);
  assert.equal(res.status, 201);
  const { approval_id } = await res.json();
  const ok = await api(`/api/approvals/${approval_id}`, {
    method: "POST",
    body: JSON.stringify({ action: "approve" }),
  });
  assert.ok(ok.ok);
});

Given("the scheduler has ticked", async function () {
  await hubMod.tick();
});

When("the scheduler ticks", async function () {
  await hubMod.tick();
});

When("the plan approval is approved", async function () {
  const s = await state();
  const approval = s.approvals.find((a: any) => a.kind === "plan_approval" && a.plan_id === planName && a.status === "pending");
  assert.ok(approval, "pending plan approval not found");
  const res = await api(`/api/approvals/${approval.id}`, {
    method: "POST",
    body: JSON.stringify({ action: "approve" }),
  });
  assert.ok(res.ok);
});

Then("the plan status is {string}", async function (status: string) {
  const s = await state();
  assert.equal(s.plans.find((p: any) => p.id === planName)?.status, status);
});

Then("a pending plan approval exists", async function () {
  const s = await state();
  assert.ok(s.approvals.some((a: any) => a.kind === "plan_approval" && a.plan_id === planName && a.status === "pending"));
});

Then("no jobs exist for the plan", async function () {
  const s = await state();
  assert.equal(s.jobs.filter((j: any) => j.plan_id === planName).length, 0);
});

Then("exactly {int} job exists for the plan", async function (n: number) {
  const s = await state();
  assert.equal(s.jobs.filter((j: any) => j.plan_id === planName).length, n);
});

Then("exactly {int} jobs exist for the plan", async function (n: number) {
  const s = await state();
  assert.equal(s.jobs.filter((j: any) => j.plan_id === planName).length, n);
});

Then("activity {string} is {string}", async function (activity: string, status: string) {
  const s = await state();
  assert.equal(s.activities.find((a: any) => a.plan_id === planName && a.id === activity)?.status, status);
});

Then("the last gate verdict for {string} is {string}", async function (activity: string, verdict: string) {
  const s = await state();
  const gates = s.gate_results.filter((g: any) => g.plan_id === planName && g.activity === activity);
  assert.ok(gates.length > 0, "no gate results");
  assert.equal(gates[0].verdict, verdict); // API returns newest first
});

When("a worker completes the job of {string} with final_loss {float}", async function (activity: string, loss: number) {
  const s = await state();
  const act = s.activities.find((a: any) => a.plan_id === planName && a.id === activity);
  assert.ok(act?.job_id, `no job for activity ${activity}`);
  const jobId = act.job_id as string;
  const metrics = { final_loss: loss, seed: 1337, config_hash: "bdd" };
  const ev = await api(`/api/jobs/${jobId}/events`, {
    method: "POST",
    body: JSON.stringify({ t: 1, pct: 100, stage: "done", state: "succeeded", metrics: { loss } }),
  });
  assert.ok(ev.ok);
  // R5: evidence is COMMITTED state — write it into the fixture bare repo
  // on the job's task branch, then report the pushed SHA with the status.
  const jobRow = await hubMod.pool.query(`SELECT repo, branch FROM jobs WHERE id = $1`, [jobId]);
  const branch = jobRow.rows[0]?.branch as string;
  const sha = commitFixtureFile("demo", branch, "runs/x/metrics.json", JSON.stringify(metrics));
  const status = await api(`/api/jobs/${jobId}/status`, {
    method: "POST",
    body: JSON.stringify({ state: "succeeded", exit_code: 0, pushed_sha: sha }),
  });
  assert.ok(status.ok);
});

When("a cyclic plan graph is submitted", async function () {
  planName = `bdd-cyclic-${Date.now().toString(36)}`;
  lastResponse = await submitPlan(CYCLIC_GRAPH);
});

// ---------- R2 git-plane steps (git-plane.feature) ----------

/** Commit a file onto a fixture bare-repo branch; returns the new tip SHA. */
function commitFixtureFile(repo: string, branch: string, file: string, content: string): string {
  const gitDir = join(reposDir, `${repo}.git`);
  const wt = mkdtempSync(join(tmpdir(), "bdd-wt-"));
  try {
    execFileSync("git", ["clone", "-q", "--no-hardlinks", gitDir, wt], { stdio: "ignore" });
    execFileSync("git", ["fetch", "-q", "origin", branch], { cwd: wt, stdio: "ignore" });
    execFileSync("git", ["checkout", "-q", "-B", "work", "FETCH_HEAD"], { cwd: wt, stdio: "ignore" });
    mkdirSync(dirname(join(wt, file)), { recursive: true });
    writeFileSync(join(wt, file), content);
    execFileSync("git", ["add", "-A"], { cwd: wt, stdio: "ignore" });
    execFileSync("bash", ["-c",
      `cd '${wt}' && git -c user.name=bdd -c user.email=bdd@local commit -q -m 'bdd: evidence'`], { stdio: "ignore" });
    // Push the commit into the bare fixture (update-ref alone would point at
    // an object the bare repo does not have).
    execFileSync("git", ["push", "-q", "origin", `work:${branch}`], { cwd: wt, stdio: "ignore" });
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: wt, encoding: "utf8" }).trim();
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
}

/** Plan-scoped task ref (R2 review fix: refs/tasks/<plan>/<activity>). */
const tref = (activity: string): string => `refs/tasks/${planName}/${activity}`;

function bare(args: string[]): string {
  return execFileSync("git", ["--git-dir", join(reposDir, "demo.git"), ...args], {
    encoding: "utf8",
  }).trim();
}

/** Create a commit object in the fixture bare repo (no worktree needed). */
function mkCommit(parent: string | null, msg: string): string {
  const gitDir = join(reposDir, "demo.git");
  const tree = parent
    ? bare(["rev-parse", `${parent}^{tree}`])
    : execFileSync("git", ["--git-dir", gitDir, "mktree"], { input: "", encoding: "utf8" }).trim();
  const p = parent ? `-p ${parent}` : "";
  return execFileSync(
    "bash",
    [
      "-c",
      `GIT_AUTHOR_NAME=bdd GIT_AUTHOR_EMAIL=bdd@local GIT_COMMITTER_NAME=bdd GIT_COMMITTER_EMAIL=bdd@local ` +
        `git --git-dir '${gitDir}' commit-tree ${tree} ${p} -m '${msg}'`,
    ],
    { encoding: "utf8" },
  ).trim();
}

/** A commit that is NOT a descendant of `ref`'s tip (sibling or new root). */
function mkNonFf(ref: string, msg: string): string {
  let base: string | null = null;
  try {
    base = bare(["rev-parse", `${ref}^`]);
  } catch {
    base = null; // tip is a root commit -> unrelated new root
  }
  return mkCommit(base, msg);
}

const r2Graph = (acts: string[]): string =>
  `goal_ref: goal.md\nactivities:\n${acts
    .map(
      (a) =>
        `  ${a}:\n    title: ${a}\n    depends_on: []\n    job: {image: "python:3.12-slim", command: ["true"]}\n`,
    )
    .join("")}`;

let r2: {
  jobId: string;
  landedTip: string;
  heldBranch: string;
  last: { allow: boolean; messages: string[] } | null;
} = { jobId: "", landedTip: "", heldBranch: "", last: null };

async function submitAndPromote(acts: string[]): Promise<string> {
  planName = `r2-${Date.now().toString(36)}`;
  const submit = await api("/api/plans", {
    method: "POST",
    body: JSON.stringify({ name: planName, graph_yaml: r2Graph(acts) }),
  });
  assert.ok(submit.ok, `plan submit failed: ${submit.status} ${await submit.text()}`);
  const s = await state();
  const approval = s.approvals.find(
    (a: any) => a.kind === "plan_approval" && a.plan_id === planName && a.status === "pending",
  );
  await api(`/api/approvals/${approval.id}`, {
    method: "POST",
    body: JSON.stringify({ action: "approve" }),
  });
  await hubMod.tick();
  const st = await state();
  const job = st.jobs.find((j: any) => j.activity === acts[0]);
  assert.ok(job, "job not promoted");
  return job.id as string;
}

async function preReceive(
  node: string,
  pushes: Array<{ old: string; new: string; ref: string }>,
): Promise<{ allow: boolean; messages: string[] }> {
  const res = await api("/internal/git/pre-receive", {
    method: "POST",
    body: JSON.stringify({ repo: "demo", token: tokens[node], pushes }),
  });
  assert.ok(res.ok, `pre-receive failed: ${res.status}`);
  return res.json();
}

Given('a plan with activity "alpha" is approved and promoted to a job', async function () {
  r2.jobId = await submitAndPromote(["alpha"]);
});

Given("the job is leased by node {string}", async function (node: string) {
  await hubMod.pool.query(
    `UPDATE jobs SET status = 'leased', node = $1, lease_expires = now() + interval '5 minutes' WHERE id = $2`,
    [node, r2.jobId],
  );
});

Given("the hub grants a one-time force authorization for {string}", async function (refArg: string) {
  const ref = refArg.startsWith("refs/tasks/") && refArg.endsWith("/alpha") ? tref("alpha") : refArg;
  await hubMod.pool.query(`INSERT INTO git_force_auth (repo, ref) VALUES ('demo', $1)`, [ref]);
});

Given("the job is leased by node {string} and pushed a commit to {string}", async function (node: string, refArg: string) {
  const ref = refArg.startsWith("refs/tasks/") && !refArg.includes("/", "refs/tasks/".length) ? tref(refArg.slice("refs/tasks/".length)) : refArg;
  await hubMod.pool.query(
    `UPDATE jobs SET status = 'leased', node = $1, lease_expires = now() + interval '5 minutes' WHERE id = $2`,
    [node, r2.jobId],
  );
  const old = bare(["rev-parse", ref]);
  const sha = mkCommit(old, "work");
  bare(["update-ref", ref, sha]);
});

Given("the job succeeded with gate pass and audit note", async function () {
  await hubMod.pool.query(`UPDATE jobs SET status = 'succeeded' WHERE id = $1`, [r2.jobId]);
  await hubMod.tick(); // gate evaluation (no gate declared -> job_state decides -> pass)
  // Verified-complete is SHA-pinned: the audit must cover the branch tip.
  const tipSha = bare(["rev-parse", tref("alpha")]);
  await hubMod.pool.query(
    `UPDATE gate_results SET audit_note = '{"verdict":"agree_pass"}', evaluated_sha = $2 WHERE plan_id = $1 AND activity = 'alpha'`,
    [planName, tipSha],
  );
});

Given('activities "alpha" and "beta" both verified-complete with diverged branches', async function () {
  r2.jobId = await submitAndPromote(["alpha", "beta"]);
  const st = await state();
  const jobs = st.jobs.filter((j: any) => j.plan_id === planName);
  assert.equal(jobs.length, 2);
  for (const j of jobs) {
    await hubMod.pool.query(
      `UPDATE jobs SET status = 'leased', node = 'worker-a', lease_expires = now() + interval '5 minutes' WHERE id = $1`,
      [j.id],
    );
    const ref = tref(j.activity as string);
    const sha = mkCommit(bare(["rev-parse", ref]), `work-${j.activity}`);
    bare(["update-ref", ref, sha]);
    await hubMod.pool.query(`UPDATE jobs SET status = 'succeeded' WHERE id = $1`, [j.id]);
  }
  await hubMod.tick(); // gate evaluation for both
  for (const activity of ["alpha", "beta"]) {
    const tip = bare(["rev-parse", tref(activity)]);
    await hubMod.pool.query(
      `UPDATE gate_results SET audit_note = '{"verdict":"agree_pass"}', evaluated_sha = $2 WHERE plan_id = $1 AND activity = $3`,
      [planName, tip, activity],
    );
  }
});

When('the hook is asked about a push of ref {string} from old {string} to a new commit', async function (refArg: string, _seed: string) {
  const ref = refArg.includes("/") && !refArg.startsWith("refs/") ? tref(refArg) : refArg;
  const old = bare(["rev-parse", "main"]);
  const sha = mkCommit(old, "probe");
  r2.last = await preReceive("worker-a", [{ old, new: sha, ref }]);
});

When('node {string} pushes a fast-forward commit to {string}', async function (node: string, refArg: string) {
  const ref = refArg.startsWith("refs/tasks/") && !refArg.includes("/", "refs/tasks/".length) ? tref(refArg.slice("refs/tasks/".length)) : refArg;
  const old = bare(["rev-parse", ref]);
  const sha = mkCommit(old, "ff");
  r2.last = await preReceive(node, [{ old, new: sha, ref }]);
  bare(["update-ref", ref, sha]);
});

When('node {string} pushes a non-fast-forward commit to {string}', async function (node: string, refArg: string) {
  const ref = refArg.startsWith("refs/tasks/") && !refArg.includes("/", "refs/tasks/".length) ? tref(refArg.slice("refs/tasks/".length)) : refArg;
  const old = bare(["rev-parse", ref]);
  const sha = mkNonFf(ref, "nff");
  r2.last = await preReceive(node, [{ old, new: sha, ref }]);
  if (r2.last.allow) bare(["update-ref", ref, sha]);
});

When('node {string} pushes the same non-fast-forward commit to {string} again', async function (node: string, refArg: string) {
  const ref = refArg.startsWith("refs/tasks/") && !refArg.includes("/", "refs/tasks/".length) ? tref(refArg.slice("refs/tasks/".length)) : refArg;
  const old = bare(["rev-parse", ref]);
  const sha = mkNonFf(ref, "nff-replay");
  r2.last = await preReceive(node, [{ old, new: sha, ref }]);
});

When("the scheduler lands verified activities", async function () {
  await hubMod.tick();
});

Then("the job carries branch {string} and base_sha equal to main", async function (branchArg: string) {
  const branch = branchArg.endsWith("/alpha") && branchArg.startsWith("refs/tasks/") ? tref("alpha") : branchArg;
  const row = await hubMod.pool.query(`SELECT branch, base_sha FROM jobs WHERE id = $1`, [r2.jobId]);
  assert.equal(row.rows[0].branch, branch);
  assert.equal(row.rows[0].base_sha, bare(["rev-parse", "main"]));
});

Then("the bare repo has ref {string} pointing at main", function (refArg: string) {
  const ref = refArg.endsWith("/alpha") && refArg.startsWith("refs/tasks/") ? tref("alpha") : refArg;
  assert.equal(bare(["rev-parse", "--verify", ref]), bare(["rev-parse", "main"]));
});

Then("the push is rejected with {string}", function (msg: string) {
  assert.ok(r2.last, "no pre-receive result");
  assert.equal(r2.last!.allow, false, JSON.stringify(r2.last));
  assert.ok(
    r2.last!.messages.some((m) => m.includes(msg)),
    `expected "${msg}" in ${JSON.stringify(r2.last!.messages)}`,
  );
});

Then("the push is accepted", function () {
  assert.ok(r2.last, "no pre-receive result");
  assert.equal(r2.last!.allow, true, JSON.stringify(r2.last));
});

Then("main in the bare repo equals the {string} tip", function (refArg: string) {
  const ref = refArg.endsWith("/alpha") && refArg.startsWith("refs/tasks/") ? tref("alpha") : refArg;
  assert.equal(bare(["rev-parse", "main"]), bare(["rev-parse", ref]));
});

Then("main in the bare repo has advanced to exactly one branch tip", async function () {
  const main = bare(["rev-parse", "main"]);
  const alphaTip = bare(["rev-parse", tref("alpha")]);
  const betaTip = bare(["rev-parse", tref("beta")]);
  const landed = [alphaTip, betaTip].filter((t) => t === main);
  assert.equal(landed.length, 1, `main=${main} alpha=${alphaTip} beta=${betaTip}`);
  r2.landedTip = main;
  r2.heldBranch = main === alphaTip ? tref("beta") : tref("alpha");
});

Then("exactly one rebase instruction exists for the other branch", async function () {
  const rows = await hubMod.pool.query(
    `SELECT * FROM rebase_instructions WHERE repo = 'demo' AND branch = $1 AND status = 'held'`,
    [r2.heldBranch],
  );
  assert.equal(rows.rows.length, 1, JSON.stringify(rows.rows));
});

Then("a one-time force authorization is available for the other branch", async function () {
  const rows = await hubMod.pool.query(
    `SELECT * FROM git_force_auth WHERE repo = 'demo' AND ref = $1 AND consumed_at IS NULL AND expires_at > now()`,
    [r2.heldBranch],
  );
  assert.ok(rows.rows.length >= 1, "no unconsumed grant");
});
