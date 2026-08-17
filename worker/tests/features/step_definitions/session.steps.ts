/**
 * Worker-session BDD steps (R4): register-then-offer against an in-process
 * fake hub implementing /api/nodes/register, the per-session SSE stream,
 * acks, and /api/workers/:id/turns. No polling — the fake hub counts every
 * request it receives.
 */
import { AfterAll, Before, BeforeAll, Given, Then, When } from "@cucumber/cucumber";
import { createServer, type Server } from "node:http";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let workerMod: any;
let fakeHub: Server | null = null;
let fakeHubURL = "";
let tmpRoot = "";
let agent: any = null;

// Fake hub state.
interface QueuedInstruction {
  id: number;
  kind: string;
  payload: Record<string, unknown>;
}
let nextId = 1;          // instruction ids
let sessionSeq = 0;     // session ids (separate counter)
let sessions = new Map<string, { acked: Set<number>; pending: QueuedInstruction[]; writers: Set<any> }>();
let requestLog: string[] = [];
let turnLog: Array<{ instruction_id?: number; kind?: string }> = [];

function emit(sessionId: string, kind: string, payload: Record<string, unknown>): QueuedInstruction {
  const s = sessions.get(sessionId)!;
  const ins = { id: nextId++, kind, payload };
  s.pending.push(ins);
  for (const w of s.writers) w(ins);
  return ins;
}

BeforeAll(async function () {
  tmpRoot = mkdtempSync(join(tmpdir(), "worker-sessions-bdd-"));
  workerMod = await import("../../../src/worker.ts");
  fakeHub = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    requestLog.push(`${req.method} ${url.pathname}`);
    if (req.method === "POST" && url.pathname === "/api/nodes/register") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const sid = `sess-${++sessionSeq}`;
        sessions.set(sid, { acked: new Set(), pending: [], writers: new Set() });
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ session_id: sid, events_path: `/api/worker-sessions/${sid}/events` }));
      });
      return;
    }
    const events = url.pathname.match(/^\/api\/worker-sessions\/([-\w]+)\/events$/);
    if (req.method === "GET" && events) {
      const s = sessions.get(events[1]);
      if (!s) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: hello\ndata: {}\n\n`);
      const write = (ins: QueuedInstruction) => {
        res.write(`id: ${ins.id}\nevent: instruction\ndata: ${JSON.stringify(ins)}\n\n`);
      };
      // Fresh buffer: ALL unacked on every connect (at-least-once).
      for (const ins of s.pending) if (!s.acked.has(ins.id)) write(ins);
      s.writers.add(write);
      req.on("close", () => s.writers.delete(write));
      return;
    }
    const ack = url.pathname.match(/^\/api\/worker-sessions\/([-\w]+)\/ack$/);
    if (req.method === "POST" && ack) {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const s = sessions.get(ack[1]);
        if (!s) {
          res.writeHead(404);
          return res.end();
        }
        const parsed = JSON.parse(body);
        if (parsed.instruction_id !== undefined) s.acked.add(parsed.instruction_id);
        // Fresh-spec accept handshake (R4): return the current job spec.
        let job = null;
        if (parsed.accept_offer?.job_id) {
          job = { id: parsed.accept_offer.job_id, image: "t", command: ["true"], requirements: {}, outputs: {}, timeout_s: 30 };
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, job }));
      });
      return;
    }
    const turns = url.pathname.match(/^\/api\/workers\/([-\w]+)\/turns$/);
    if (req.method === "POST" && turns) {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body);
        if (parsed.kind === "instruction_turn") turnLog.push(parsed);
        res.writeHead(200);
        res.end('{"ok":true}');
      });
      return;
    }
    const spec = url.pathname.match(/^\/api\/jobs\/([^/]+)\/spec$/);
    if (req.method === "GET" && spec) {
      // Minimal job spec (retrospective flow not exercised here).
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => fakeHub!.listen(0, "127.0.0.1", resolve));
  fakeHubURL = `http://127.0.0.1:${(fakeHub!.address() as any).port}`;
});

AfterAll(async function () {
  (fakeHub as any).closeAllConnections?.();
  await new Promise<void>((resolve) => fakeHub!.close(() => resolve()));
  rmSync(tmpRoot, { recursive: true, force: true });
  sessions = new Map();
  requestLog = [];
  turnLog = [];
  nextId = 1;
});

Before(function () {
  // Scenario isolation: fresh session space + counters per scenario.
  nextId = 1;
  sessionSeq = 0;
  sessions = new Map();
  requestLog = [];
  turnLog = [];
  agent = null;
});

Given("a fake hub with SSE instruction streams", function () {
  assert.ok(fakeHubURL, "fake hub running");
});

When("the worker agent registers", async function () {
  agent = new workerMod.WorkerAgent({
    hubUrl: fakeHubURL,
    nodeId: "bdd-worker",
    workDir: join(tmpRoot, "work"),
  });
  await agent.register();
  void agent.streamOnce(); // background consume loop (runs until disconnect)
  await new Promise((r) => setTimeout(r, 150)); // let the SSE connect
});

Then("it holds a session id", function () {
  assert.match(agent.sessionId, /^sess-/);
});

When("the hub offers instruction {int} as {string} with a quick job", async function (id: number, kind: string) {
  process.env.WORK_DIR = join(tmpRoot, "work");
  const ins = emit(agent.sessionId, kind, {
    job: {
      id: `job-${id}`,
      image: "t",
      command: ["true"],
      requirements: {},
      outputs: {},
      timeout_s: 30,
      repo: "demo",
      branch: undefined,
    },
  });
  assert.equal(ins.id, id);
  await new Promise((r) => setTimeout(r, 150));
});

When("the hub sends instruction {int} as {string}", async function (id: number, kind: string) {
  const payload: Record<string, unknown> = { job_id: "job-1", note: `hello ${kind}` };
  if (kind === "exit") payload.reason = "post_merge";
  const ins = emit(agent.sessionId, kind, payload);
  assert.equal(ins.id, id);
  await new Promise((r) => setTimeout(r, 150));
});

When("the hub sends instruction {int} as {string} and the worker processes it", async function (id: number, kind: string) {
  const ins = emit(agent.sessionId, kind, { note: "payload" });
  assert.equal(ins.id, id);
  await new Promise((r) => setTimeout(r, 200));
});

Then("the worker acked instruction {int} with offer acceptance", function (id: number) {
  const ack = agent.acks.find((a: any) => a.id === id);
  assert.ok(ack, `no ack for ${id}: ${JSON.stringify(agent.acks)}`);
  assert.ok(ack.accept, "offer not accepted");
});

Then("the worker consumed instructions {int} and {int} as turns", function (a: number, b: number) {
  const ids = agent.consumedTurns.map((t: any) => t.id);
  for (const id of [a, b]) assert.ok(ids.includes(id), `instruction ${id} not consumed: ${JSON.stringify(ids)}`);
  const kinds = agent.consumedTurns.map((t: any) => t.kind);
  assert.ok(kinds.includes("gate_feedback"), "gate_feedback not a turn input");
});

Then("the worker consumed instruction {int} as a turn", function (id: number) {
  const ids = agent.consumedTurns.map((t: any) => t.id);
  assert.ok(ids.includes(id), `instruction ${id} not consumed: ${JSON.stringify(ids)}`);
});

Then("the worker is still operational — no exit before the signal", function () {
  assert.equal(agent.exited, false, "worker exited before the exit signal");
  assert.equal(agent.exitPending, null, "exit pending before the exit signal");
});



Then("the worker exits after the exit signal while idle", async function () {
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(agent.exitPending, "post_merge");
  assert.equal(agent.exited, true, "worker should honor the exit signal once idle");
});

When("the worker disconnects without acking", async function () {
  // Drop all SSE writers server-side (disconnect) AND simulate ack loss for
  // undelivered/unacked instructions — the buffer keeps them (at-least-once).
  const s = sessions.get(agent.sessionId)!;
  s.writers.clear();
  for (const ins of s.pending) s.acked.delete(ins.id);
});

When("the worker reconnects", async function () {
  const redelivered: number[] = [];
  (agent as any).__redelivered = redelivered;
  agent.handleInstruction = async (ins: any) => {
    // Redelivery: record it and ack immediately this time.
    redelivered.push(ins.id);
    await agent.ack(ins.id);
  };
  void agent.streamOnce();
  await new Promise((r) => setTimeout(r, 200));
});

Then("the worker receives instruction {int} again — at-least-once", function (id: number) {
  const redelivered: number[] = (agent as any).__redelivered ?? [];
  assert.ok(redelivered.includes(id), `instruction ${id} not redelivered: ${JSON.stringify(redelivered)}`);
});

Then("no work-poll request was made", function () {
  const polls = requestLog.filter((r) => r === "GET /api/work" || r.startsWith("GET /api/work?"));
  assert.deepEqual(polls, [], `worker polled for work: ${JSON.stringify(polls)}`);
});
