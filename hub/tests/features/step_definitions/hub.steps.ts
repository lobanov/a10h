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

let baseURL = "";
let hubMod: any;
let server: any;
let scratchDb = "";
let lastResponse: Response | null = null;
let pulled: Record<string, unknown | null> = {};
let planName = "";

const PLAN_GRAPH = `goal_ref: goal.md
activities:
  alpha:
    title: alpha
    depends_on: []
    job: {image: "python:3.12-slim", command: ["true"], requirements: {cpu: 1}}
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

  hubMod = await import("../../../src/index-export.ts");
  await hubMod.migrate();
  server = hubMod.createHttpServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  baseURL = `http://127.0.0.1:${server.address().port}`;
});

After(async function () {
  // Scenario isolation: scratch DB is shared; wipe mutable tables between scenarios.
  await hubMod.pool.query(
    "TRUNCATE nodes, jobs, job_events, artifacts, plans, activities, gate_results, approvals, agent_log",
  );
  lastResponse = null;
  pulled = {};
});

AfterAll(async function () {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await hubMod.pool.end();
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
  const result = await api(`/api/jobs/${jobId}/result`, {
    method: "POST",
    body: JSON.stringify({ evidence: [{ path: "runs/x/metrics.json", content: JSON.stringify(metrics) }] }),
  });
  assert.ok(result.ok);
  const status = await api(`/api/jobs/${jobId}/status`, {
    method: "POST",
    body: JSON.stringify({ state: "succeeded", exit_code: 0 }),
  });
  assert.ok(status.ok);
});

When("a cyclic plan graph is submitted", async function () {
  planName = `bdd-cyclic-${Date.now().toString(36)}`;
  lastResponse = await submitPlan(CYCLIC_GRAPH);
});
