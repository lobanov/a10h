/**
 * Worker BDD steps. Exercises the real runner module (no docker): tag
 * parsing, multi-file progress discovery, event relaying + cancellation
 * against an in-process fake hub, and git clone checkouts.
 */
import { After, AfterAll, BeforeAll, Given, Then, When } from "@cucumber/cucumber";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert";

let runner: any;
let tmpRoot = "";
let workspace = "";
let fakeHub: Server | null = null;
let fakeHubURL = "";
let capturedEvents: Array<{ jobId: string; body: any }> = [];
let cancelAfter = Infinity; // number of events after which the hub asks to cancel
let cancelled = false;
let foundFiles: string[] = [];
let checkoutDir = "";
let parsed: Record<string, unknown> = {};

function makeWorkspace(relPaths: string[]): string {
  const dir = mkdtempSync(join(tmpRoot, "ws-"));
  for (const rel of relPaths) {
    const file = join(dir, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "");
  }
  return dir;
}

function sh(cmd: string, args: string[], opts: { cwd?: string } = {}) {
  return execFileSync(cmd, args, { cwd: opts.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

BeforeAll(async function () {
  tmpRoot = mkdtempSync(join(tmpdir(), "worker-bdd-"));
  process.env.HUB_URL = "http://127.0.0.1:1"; // placeholder; overridden per scenario
  runner = await import("../../../src/runner.ts");
});

AfterAll(async function () {
  rmSync(tmpRoot, { recursive: true, force: true });
});

After(async function () {
  if (fakeHub) {
    await new Promise<void>((resolve) => fakeHub!.close(() => resolve()));
    fakeHub = null;
  }
  capturedEvents = [];
  cancelAfter = Infinity;
  cancelled = false;
});

// ---------- tags ----------

When("tags are parsed from {string}", function (spec: string) {
  parsed = runner.parseTags(spec);
});

Then("the tag {string} is {int}", function (key: string, value: number) {
  assert.equal(parsed[key], value);
});

Then("the tag {string} is true", function (key: string) {
  assert.equal(parsed[key], true);
});

Then("the tag {string} is {string}", function (key: string, value: string) {
  assert.equal(parsed[key], value);
});

// ---------- progress discovery ----------

Given("a workspace containing progress.jsonl at {string}", function (rel: string) {
  workspace = makeWorkspace([rel]);
});

Given("a workspace containing progress.jsonl at {string}, {string} and {string}", function (a: string, b: string, c: string) {
  workspace = makeWorkspace([a, b, c]);
});

When("progress files are discovered", function () {
  foundFiles = runner.findProgressFiles(workspace);
});

Then("{int} progress files are found", function (n: number) {
  assert.equal(foundFiles.length, n);
});

Then("none of them are inside .git", function () {
  assert.ok(foundFiles.every((f) => !f.includes("/.git/")), JSON.stringify(foundFiles));
});

// ---------- progress relay & cancellation ----------

Given("a fake hub capturing job events", async function () {
  await startFakeHub();
});

Given("a fake hub capturing job events that requests cancellation", async function () {
  cancelAfter = 1;
  await startFakeHub();
});

async function startFakeHub(): Promise<void> {
  fakeHub = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const match = req.url?.match(/^\/api\/jobs\/([^/]+)\/events$/);
      if (match && req.method === "POST") {
        capturedEvents.push({ jobId: match[1], body: JSON.parse(body) });
        const cancel = capturedEvents.length >= cancelAfter;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, cancel }));
        return;
      }
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise<void>((resolve) => fakeHub!.listen(0, "127.0.0.1", () => resolve()));
  fakeHubURL = `http://127.0.0.1:${(fakeHub.address() as any).port}`;
  process.env.HUB_URL = fakeHubURL;
}

When("the progress tailer runs for job {string} and {int} valid lines are appended", async function (jobId: string, n: number) {
  const dir = jobId.startsWith("cancel") ? "y" : "x";
  const progressFile = join(workspace, "runs", dir, "progress.jsonl");
  const tailer = runner.startProgressTail(
    { id: jobId, image: "t", command: ["true"], requirements: {}, outputs: {}, timeout_s: 60 },
    workspace,
    () => {
      cancelled = true;
    },
  );
  for (let i = 1; i <= n; i++) {
    const line = JSON.stringify({ t: i, pct: (100 * i) / n, stage: `step ${i}/${n}` });
    writeFileSync(progressFile, line + "\n", { flag: "a" });
    await new Promise((r) => setTimeout(r, 700)); // > tail poll interval (500ms)
  }
  tailer.stop();
  await new Promise((r) => setTimeout(r, 200));
});

Then("the fake hub received {int} events for job {string}", function (n: number, jobId: string) {
  assert.equal(capturedEvents.filter((e) => e.jobId === jobId).length, n);
});

Then("the fake hub received exactly {int} event for job {string}", function (n: number, jobId: string) {
  assert.equal(capturedEvents.filter((e) => e.jobId === jobId).length, n);
});

Then("each event has fields {string}, {string} and {string}", function (a: string, b: string, c: string) {
  assert.ok(capturedEvents.length > 0);
  for (const e of capturedEvents) {
    assert.ok(e.body[a] !== undefined, `missing ${a}`);
    assert.ok(e.body[b] !== undefined, `missing ${b}`);
    assert.ok(e.body[c] !== undefined, `missing ${c}`);
  }
});

Then("the cancellation callback was invoked", function () {
  assert.ok(cancelled, "onCancel was never called");
});

// ---------- checkout (git plane, R3) ----------

Given("a gitserver origin repo containing {string}", function (_file: string) {
  // Stand-in for the hub gitserver: a bare repo reachable as a local origin
  // URL, seeded on main plus a task branch with branch-specific content.
  const origin = join(tmpRoot, "gitserver-origin");
  rmSync(origin, { recursive: true, force: true });
  mkdirSync(origin, { recursive: true });
  const wt = join(tmpRoot, "origin-wt");
  rmSync(wt, { recursive: true, force: true });
  mkdirSync(wt, { recursive: true });
  sh("git", ["init", "-q", "-b", "main"], { cwd: wt });
  writeFileSync(join(wt, "seed.txt"), "seed\n");
  sh("git", ["add", "."], { cwd: wt });
  sh("git", ["-c", "user.name=bdd", "-c", "user.email=bdd@test", "commit", "-q", "-m", "init"], { cwd: wt });
  sh("git", ["clone", "-q", "--bare", wt, join(origin, "demo.git")], { cwd: wt });
  // Task branch at main tip + one commit with branch-specific content.
  writeFileSync(join(wt, "branch-only.txt"), "from task branch\n");
  sh("git", ["add", "."], { cwd: wt });
  sh("git", ["-c", "user.name=bdd", "-c", "user.email=bdd@test", "commit", "-q", "-m", "task"], { cwd: wt });
  sh("git", ["push", "-q", join(origin, "demo.git"), `HEAD:refs/tasks/alpha`], { cwd: wt });
  process.env.GITSERVER_URL = origin; // plain path origin (no token/CA needed)
  delete process.env.GIT_TOKEN_FILE;
  this.origin = origin;
});

Given("WORK_DIR pointing at an empty dir", function () {
  process.env.WORK_DIR = mkdtempSync(join(tmpRoot, "work-"));
});

When("a checkout is created for job {string} on task branch {string}", function (jobId: string, branch: string) {
  const co = runner.checkout({
    id: jobId, image: "t", command: ["true"], requirements: {}, outputs: {},
    timeout_s: 60, repo: "demo", branch,
  });
  checkoutDir = co.dir;
});

Then("the checkout contains {string}", function (file: string) {
  assert.ok(existsSync(join(checkoutDir, file)), `${file} missing in ${checkoutDir}`);
});

Then("the checkout does not contain {string}", function (file: string) {
  assert.ok(!existsSync(join(checkoutDir, file)), `${file} unexpectedly present in ${checkoutDir}`);
});

Then("the checkout tracks content from the task branch", function () {
  const head = sh("git", ["rev-parse", "HEAD"], { cwd: checkoutDir }).trim();
  const fetched = sh("git", ["rev-parse", "FETCH_HEAD"], { cwd: checkoutDir }).trim();
  const main = sh("git", ["rev-parse", "origin/main"], { cwd: checkoutDir }).trim();
  assert.ok(
    readFileSync(join(checkoutDir, "branch-only.txt"), "utf8").includes("task branch"),
    "checkout is not at the task branch tip",
  );
  assert.equal(head, fetched, "HEAD is not the fetched task-branch tip");
  assert.notEqual(head, main, "task branch tip equals main — fixture is wrong");
});

When("the job's work products are committed and pushed to the task branch", function () {
  writeFileSync(join(checkoutDir, "result.txt"), "result\n");
  const res = runner.commitAndPush({
    id: "push-1", image: "t", command: ["true"], requirements: {}, outputs: {},
    timeout_s: 60, repo: "demo", branch: "refs/tasks/alpha",
  }, checkoutDir);
  this.pushResult = res;
});

Then("the push succeeds and the origin branch advanced", function () {
  assert.equal(this.pushResult.pushed, true, JSON.stringify(this.pushResult));
  const origin = join(this.origin, "demo.git");
  const tip = sh("git", ["--git-dir", origin, "rev-parse", "refs/tasks/alpha"]).trim();
  const local = sh("git", ["rev-parse", "HEAD"], { cwd: checkoutDir }).trim();
  assert.equal(tip, local);
});

Then("jobs without a task branch are rejected", function () {
  assert.throws(
    () => runner.checkout({ id: "nobranch", image: "t", command: ["true"], requirements: {}, outputs: {}, timeout_s: 60 }),
    /no task branch/,
  );
});

// ---------- workload subprocess hosting ----------

When("a workload runs the command {string}", async function (cmdLine: string) {
  const m = cmdLine.match(/^([^' ]+) -c '(.+)'$/);
  const command = m ? [m[1], "-c", m[2]] : cmdLine.split(" ");
  const handle = runner.runWorkload({ command, cwd: workspace, timeout_s: 30 });
  this.workload = await handle.done;
});

When("a workload runs the command {string} with timeout {int} second", async function (cmdLine: string, seconds: number) {
  const before = process.hrtime.bigint();
  this.beforeSleepPids = sleepPids();
  // sh -c so quoted bodies with shell syntax stay one command string
  const m = cmdLine.match(/^([^' ]+) -c '(.+)'$/);
  const command = m ? [m[1], "-c", m[2]] : cmdLine.split(" ");
  const handle = runner.runWorkload({ command, cwd: workspace, timeout_s: seconds });
  this.workload = await handle.done;
  this.elapsedMs = Number(process.hrtime.bigint() - before) / 1e6;
});

Then("the workload exit code is {int}", function (code: number) {
  assert.equal(this.workload.exitCode, code);
});

Then("the workload exit code is nonzero", function () {
  assert.notEqual(this.workload.exitCode, 0);
});

Then("the workload was killed by timeout", function () {
  assert.equal(this.workload.timedOut, true);
  assert.ok(this.elapsedMs < 15000, `timeout kill took ${Math.round(this.elapsedMs)}ms (expected ~1s)`);
});

Then("the workspace file {string} contains {string}", function (file: string, content: string) {
  const text = readFileSync(join(workspace, file), "utf8");
  assert.ok(text.includes(content), `expected "${content}" in "${text}"`);
});

Then("the sleep subprocess is no longer running", function () {
  // Only processes created by this scenario count (unrelated host sleeps excluded).
  const survivors = sleepPids().filter((p) => !(this.beforeSleepPids ?? []).includes(p));
  assert.equal(survivors.length, 0, `surviving sleep processes: ${survivors.join("; ")}`);
});

function sleepPids(): string[] {
  try {
    return execFileSync("sh", ["-c", "ps -eo pid,comm | awk '$2 ~ /sleep/ {print $1}' || true"], {
      encoding: "utf8",
    })
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}
