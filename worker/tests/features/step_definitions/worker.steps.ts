/**
 * Worker BDD steps. Exercises the real runner module (no docker): tag
 * parsing, multi-file progress discovery, event relaying + cancellation
 * against an in-process fake hub, and git clone checkouts.
 */
import { After, AfterAll, BeforeAll, Given, Then, When } from "@cucumber/cucumber";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

// ---------- checkout ----------

Given("a git origin repo containing {string}", function (_file: string) {
  const origin = mkdtempSync(join(tmpRoot, "origin-"));
  sh("git", ["init", "-q", "-b", "main"], { cwd: origin });
  sh("git", ["-c", "user.name=bdd", "-c", "user.email=bdd@test", "add", "-A"], { cwd: origin });
  writeFileSync(join(origin, "seed.txt"), "seed\n");
  sh("git", ["add", "."], { cwd: origin });
  sh("git", ["-c", "user.name=bdd", "-c", "user.email=bdd@test", "commit", "-q", "-m", "init"], { cwd: origin });
  process.env.REPO_PATH = origin;
  process.env.CHECKOUT_STRATEGY = "clone";
  this.origin = origin;
});

Given("REPO_PATH pointing at the origin and WORK_DIR pointing at an empty dir", function () {
  process.env.WORK_DIR = mkdtempSync(join(tmpRoot, "work-"));
});

When("a checkout is created for job {string}", function (jobId: string) {
  checkoutDir = runner.checkout({ id: jobId, image: "t", command: ["true"], requirements: {}, outputs: {}, timeout_s: 60 });
});

Then("the checkout contains {string}", function (file: string) {
  assert.ok(existsSync(join(checkoutDir, file)), `${file} missing in ${checkoutDir}`);
});

Then("the checkout is not the origin itself", function () {
  assert.notEqual(checkoutDir, this.origin);
});
