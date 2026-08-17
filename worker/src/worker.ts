/**
 * Worker agent entrypoint (R4, DESIGN.md §7.1): register-then-offer.
 *
 * On start the worker ANNOUNCES itself at the hub's well-known registration
 * URL and receives a session id (its container-lifetime identity). It then
 * waits on its own SSE instruction stream — no polling loop — and dispatches
 * every instruction through its Pi agent session (a turn input); the M3
 * runner remains the executor (checkout, workload, push, rebase as tools the
 * agent triggers). Exit happens only on the hub's exit signal (post-merge /
 * attempt closure), deferred until idle; compose `restart: always` recreates
 * the container for its next task. Mid-task death is never rescued — the hub
 * lease expires and the task requeues from scratch on the same branch.
 *
 * Env: HUB_URL, NODE_ID, NODE_TAGS, WORK_DIR, GITSERVER_URL, GIT_TOKEN_FILE,
 * GIT_SSL_CAINFO, HF_STORE_PATH, WORKER_MODEL (optional — agent turns; when
 * unset, instructions dispatch deterministically and turns are logged).
 */
import { join, resolve } from "node:path";
import { writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  checkout,
  commitAndPush,
  executeJob,
  rebaseOntoMain,
  parseTags,
  type JobSpec,
} from "./runner.ts";

export interface Instruction {
  id: number;
  kind: string;
  payload: Record<string, unknown>;
}

// --- Pi agent session (turn inputs for instructions; runner = tools) ------
// Optional at runtime; without WORKER_MODEL the agent runs deterministically
// (instructions dispatch directly; turns are recorded to the hub).
async function importPiWorker(): Promise<any> {
  const pkg = "@earendil-works/pi-coding-agent";
  const global = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
  try {
    return await import(/* @vite-ignore */ pkg);
  } catch {
    return await import(/* @vite-ignore */ global);
  }
}

function buildModelsJson(path: string): void {
  const providers: Record<string, unknown> = {};
  const localUrl = process.env.LOCAL_LLM_BASE_URL ?? "";
  if (localUrl) {
    providers["local"] = {
      api: "openai-completions",
      baseUrl: localUrl,
      apiKey: process.env.LOCAL_LLM_API_KEY || "none",
      models: [
        {
          id: process.env.LOCAL_LLM_MODEL ?? "default",
          name: "Local model",
          contextWindow: 131072,
          input: ["text"],
        },
      ],
    };
  }
  mkdirSync(tmpdir(), { recursive: true });
  writeFileSync(path, JSON.stringify({ providers }));
}

interface AgentHandle {
  prompt: (text: string) => Promise<string>;
}

async function createAgentSessionHandle(model: string): Promise<AgentHandle> {
  const mod: any = await importPiWorker();
  const modelsPath = "/tmp/worker-models.json";
  buildModelsJson(modelsPath);
  const runtime = await mod.ModelRuntime.create({ modelsPath });
  const [provider, ...rest] = model.split("/");
  const m = runtime.getModel(provider, rest.join("/"));
  if (!m) throw new Error(`model ${model} not found`);
  const { session } = await mod.createAgentSession({
    model: m,
    systemPrompt:
      "You are a research worker agent in the Pi Autoresearch Lab. Hub " +
      "instructions arrive as your turn inputs. Trigger the tools to act; " +
      "never claim work you did not perform; report failures honestly.",
  });
  return {
    prompt: async (text: string) => {
      const result = await session.prompt(text);
      const blocks = result?.content ?? result ?? [];
      const out = (Array.isArray(blocks) ? blocks : [])
        .filter((b: any) => b?.type === "text")
        .map((b: any) => b.text)
        .join("\n");
      return out || "(no output)";
    },
  };
}

export class WorkerAgent {
  sessionId = "";
  currentJob: JobSpec | null = null;
  exitPending: string | null = null;
  exited = false;
  /** One task per container: this generation never accepts a second offer. */
  hasCompletedTask = false;
  /** Observability for tests: every consumed instruction turn. */
  consumedTurns: Array<{ id: number; kind: string }> = [];
  acks: Array<{ id: number; accept?: string }> = [];
  private agent: AgentHandle | null = null;
  private stopRequested = false;

  private opts: { hubUrl: string; nodeId: string; workDir: string; workerModel?: string };

  constructor(opts: { hubUrl: string; nodeId: string; workDir: string; workerModel?: string }) {
    this.opts = opts;
  }

  private async hub(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${this.opts.hubUrl}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    });
  }

  private async logTurn(kind: string, data: Record<string, unknown>): Promise<void> {
    if (!this.sessionId) return;
    try {
      await this.hub(`/api/workers/${this.sessionId}/turns`, {
        method: "POST",
        body: JSON.stringify({ kind, node: this.opts.nodeId, ...data }),
      });
    } catch {
      /* observability best-effort */
    }
  }

  /** Every instruction is a Pi turn input (or a deterministic dispatch). */
  private async consume(instruction: Instruction): Promise<void> {
    this.consumedTurns.push({ id: instruction.id, kind: instruction.kind });
    const turnInput =
      `hub instruction ${instruction.id} (${instruction.kind}): ` +
      JSON.stringify(instruction.payload).slice(0, 2000);
    if (this.agent) {
      const output = await this.agent.prompt(turnInput);
      await this.logTurn("instruction_turn", {
        instruction_id: instruction.id,
        kind: instruction.kind,
        input: turnInput,
        output: output.slice(0, 4000),
      });
    } else {
      await this.logTurn("instruction_turn", {
        instruction_id: instruction.id,
        kind: instruction.kind,
        input: turnInput,
        output: "deterministic dispatch (no WORKER_MODEL)",
      });
    }
  }

  private async ack(instructionId: number, acceptJobId?: string): Promise<void> {
    const body: Record<string, unknown> = { instruction_id: instructionId };
    if (acceptJobId) body.accept_offer = { job_id: acceptJobId };
    this.acks.push({ id: instructionId, accept: acceptJobId });
    const res = await this.hub(`/api/worker-sessions/${this.sessionId}/ack`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!res.ok) console.log(`[${this.opts.nodeId}] ack ${instructionId} failed: ${res.status}`);
  }

  /** Accept a work offer; returns the FRESH job spec on success. */
  private async acceptOffer(
    instructionId: number,
    jobId: string,
  ): Promise<JobSpec | null> {
    this.acks.push({ id: instructionId, accept: jobId });
    const body = { instruction_id: instructionId, accept_offer: { job_id: jobId } };
    const res = await this.hub(`/api/worker-sessions/${this.sessionId}/ack`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.log(`[${this.opts.nodeId}] offer ${jobId} rejected (${res.status})`);
      return null;
    }
    const parsed = (await res.json()) as { job: JobSpec | null };
    return parsed.job;
  }

  async initAgent(): Promise<void> {
    const model = this.opts.workerModel ?? process.env.WORKER_MODEL ?? "";
    if (!model) return;
    try {
      this.agent = await createAgentSessionHandle(model);
      await this.logTurn("agent_ready", { model });
    } catch (e) {
      await this.logTurn("agent_init_failed", { error: String(e) });
    }
  }

  async register(): Promise<void> {
    const res = await this.hub("/api/nodes/register", {
      method: "POST",
      body: JSON.stringify({
        node_id: this.opts.nodeId,
        tags: parseTags(process.env.NODE_TAGS ?? "cpu:4"),
      }),
    });
    if (!res.ok) throw new Error(`register ${res.status}`);
    const reg = (await res.json()) as { session_id: string };
    this.sessionId = reg.session_id;
    console.log(`[${this.opts.nodeId}] registered (session ${this.sessionId.slice(0, 8)}…)`);
  }

  async handleInstruction(instruction: Instruction): Promise<void> {
    console.log(`[${this.opts.nodeId}] instruction #${instruction.id}: ${instruction.kind}`);
    switch (instruction.kind) {
      case "work_offer": {
        let job = instruction.payload.job as JobSpec;
        await this.consume(instruction);
        if (this.hasCompletedTask || this.exitPending) {
          // One task per container: the offer expires hub-side (30s) and is
          // re-offered to another generation. Ack to clear the buffer only.
          console.log(`[${this.opts.nodeId}] refusing offer ${job.id} (task done / exit pending)`);
          await this.ack(instruction.id);
          break;
        }
        const accepted = await this.acceptOffer(instruction.id, job.id);
        if (!accepted) break; // offer expired hub-side; it will be re-offered
        job = accepted; // fresh spec (attempt may have advanced since the offer)
        this.hasCompletedTask = true;
        this.currentJob = job;
        try {
          await executeJob(job);
        } catch (e) {
          console.log(`[${this.opts.nodeId}] job ${job.id} execution error: ${(e as Error).message}`);
          await this.hub(`/api/jobs/${job.id}/status`, {
            method: "POST",
            body: JSON.stringify({ state: "failed", exit_code: 1, attempt: job.attempt }),
          }).catch(() => undefined);
        } finally {
          this.currentJob = null;
          // One task per container: no new offers after completion — the
          // session stays non-idle until the exit signal (post-merge /
          // attempt closure); repair/rebase for THIS task still arrive.
        }
        break;
      }
      case "gate_feedback": {
        // Consumed as an agent turn input; the repair re-offer follows.
        await this.consume(instruction);
        await this.ack(instruction.id);
        break;
      }
      case "retrospective_prompt": {
        await this.consume(instruction);
        await this.writeRetrospective(instruction);
        await this.ack(instruction.id);
        break;
      }
      case "rebase": {
        await this.consume(instruction);
        const { repo, branch, target_main_sha, job_id } = instruction.payload as {
          repo: string;
          branch: string;
          target_main_sha: string;
          job_id: string;
        };
        const dir = join(this.opts.workDir, `${job_id}-rebase`);
        rmSync(dir, { recursive: true, force: true });
        const co = checkout({ id: `${job_id}-rebase`, repo, branch } as JobSpec);
        const r = rebaseOntoMain({ dir: co.dir, repo, branch, targetMainSha: target_main_sha });
        console.log(`[${this.opts.nodeId}] rebase: ${r.detail}`);
        await this.logTurn("rebase_result", { job_id, ...r });
        rmSync(dir, { recursive: true, force: true });
        await this.ack(instruction.id);
        break;
      }
      case "cancel": {
        await this.consume(instruction);
        const jobId = instruction.payload.job_id as string | undefined;
        console.log(`[${this.opts.nodeId}] cancel received for ${jobId ?? "?"}`);
        await this.ack(instruction.id);
        break;
      }
      case "exit": {
        // Deferred until idle: a worker never abandons a running task.
        await this.consume(instruction);
        await this.ack(instruction.id);
        this.exitPending = String((instruction.payload as { reason?: string }).reason ?? "exit");
        break;
      }
      default:
        await this.consume(instruction);
        await this.ack(instruction.id);
    }
    if (this.exitPending && !this.currentJob) {
      console.log(`[${this.opts.nodeId}] exit signal (${this.exitPending}) — exiting`);
      this.exited = true;
    }
  }

  /** Retrospective: canned template until the secretary (R6) authors richer
   * ones; committed onto the task branch so the record lives in git. */
  private async writeRetrospective(instruction: Instruction): Promise<void> {
    const { job_id, activity, template } = instruction.payload as {
      job_id?: string;
      activity?: string;
      template?: string;
    };
    if (!job_id) return;
    const jobRow = await this.hub(`/api/jobs/${job_id}/spec`).catch(() => null);
    if (!jobRow || !jobRow.ok) return;
    const job = (await jobRow.json()) as JobSpec;
    if (!job.branch) return;
    const dir = join(this.opts.workDir, `${job_id}-retro`);
    rmSync(dir, { recursive: true, force: true });
    let co: { dir: string };
    try {
      co = checkout({ ...job, id: `${job_id}-retro` });
    } catch (e) {
      console.log(`[${this.opts.nodeId}] retrospective checkout failed (branch gone?): ${(e as Error).message}`);
      return;
    }
    const retro =
      (template ?? "# Worker retrospective") +
      `\n- activity: ${activity ?? job.activity ?? "?"}\n- job: ${job_id}\n- node: ${this.opts.nodeId}\n`;
    writeFileSync(join(co.dir, `runs/${job.activity ?? "task"}/retrospective.md`), retro, {
      flag: "a",
    });
    const pushed = commitAndPush({ ...job, id: `${job_id}-retro` }, co.dir);
    console.log(`[${this.opts.nodeId}] retrospective committed: ${pushed.detail}`);
    rmSync(dir, { recursive: true, force: true });
  }

  /** One SSE connection pass; resolves when the stream closes. onExit fires
   * when the exit signal is honored (idle). */
  async streamOnce(onExit?: () => void): Promise<void> {
    const res = await fetch(`${this.opts.hubUrl}/api/worker-sessions/${this.sessionId}/events`);
    if (!res.ok || !res.body) throw new Error(`sse ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const evLine = frame.split("\n").find((l) => l.startsWith("event: "));
        const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
        // Only instruction frames (hello/keepalives are ignored).
        if (!dataLine || (evLine && !evLine.includes("instruction"))) continue;
        const instruction = JSON.parse(dataLine.slice(6)) as Instruction;
        try {
          await this.handleInstruction(instruction);
        } catch (e) {
          // Instruction handlers must never kill the SSE loop — log, ack
          // nothing further, keep streaming (the hub requeues what matters).
          console.log(
            `[${this.opts.nodeId}] instruction #${instruction.id} (${instruction.kind}) handler error: ${(e as Error).message}`,
          );
          await this.ack(instruction.id).catch(() => undefined);
        }
        if (this.exited) {
          onExit?.();
          this.stopRequested = true;
          return;
        }
      }
    }
  }

  get stopped(): boolean {
    return this.stopRequested;
  }
}

// --- container entrypoint ----------------------------------------------------
const NODE_ID = process.env.NODE_ID ?? `worker-${process.pid}`;
const HUB_URL = (process.env.HUB_URL ?? "http://localhost:8080").replace(/\/$/, "");
const WORK_DIR = resolve(process.env.WORK_DIR ?? "/work");

async function main(): Promise<void> {
  console.log(
    `[${NODE_ID}] worker agent up (hub=${HUB_URL}, gitserver=${process.env.GITSERVER_URL ?? "UNSET"}, model=${process.env.WORKER_MODEL ?? "deterministic"})`,
  );
  const agent = new WorkerAgent({
    hubUrl: HUB_URL,
    nodeId: NODE_ID,
    workDir: WORK_DIR,
  });
  await agent.initAgent();
  for (;;) {
    try {
      await agent.register();
    } catch (e) {
      console.log(`[${NODE_ID}] register failed (${(e as Error).message}) — retrying`);
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    // Reconnect loop: a closed stream reconnects (fresh buffer redelivers
    // unacked instructions); a lost session re-registers.
    for (;;) {
      try {
        await agent.streamOnce(() => process.exit(0));
        if (agent.stopped) return;
        console.log(`[${NODE_ID}] stream closed — reconnecting`);
      } catch (e) {
        if (agent.sessionId) {
          console.log(`[${NODE_ID}] sse error: ${(e as Error).message} — reconnecting`);
          await new Promise((r) => setTimeout(r, 1000));
        } else break; // unknown session -> re-register
      }
    }
  }
}

// Auto-start guard: run only as the entrypoint (npm start / container CMD).
import { pathToFileURL } from "node:url";
const isEntrypoint = (() => {
  try {
    return process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
  } catch {
    return false;
  }
})();
if (isEntrypoint) {
  main().catch((e) => {
    console.error(`[${NODE_ID}] fatal:`, e);
    process.exit(1);
  });
}
