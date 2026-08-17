import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Worker runner (R3): pull work from the hub and host job workloads as
 * **subprocesses inside this container** — no host docker socket, no sibling
 * containers: a compromised workload stays confined to the worker container
 * (root inside it, nothing on the host). Never accepts inbound connections.
 *
 * Git plane (R3): each job checks out its task branch from the hub gitserver
 * — a FULL clone of `<GITSERVER_URL>/<repo>.git` (CA + worker token), fetch +
 * checkout of `refs/tasks/<activity>` — and pushes results back to the same
 * branch. The checkout is deleted at task end; no worktrees, no /repo mount.
 *
 * Env: HUB_URL, NODE_ID, NODE_TAGS, WORK_DIR, GITSERVER_URL, GIT_TOKEN_FILE
 * (optional for non-http origins), GIT_SSL_CAINFO, HF_STORE_PATH. The job
 * spec's `image` field is advisory — matched via node tags.
 */

function getHub(): string {
  return process.env.HUB_URL ?? "http://localhost:8080";
}
const NODE_ID = process.env.NODE_ID ?? `worker-${process.pid}`;
const NODE_TAGS = parseTags(process.env.NODE_TAGS ?? "cpu:4");
const WORK_DIR = resolve(process.env.WORK_DIR ?? "/work");
const POLL_MS = 1_000;
const HEARTBEAT_MS = 10_000;

export interface JobSpec {
  id: string;
  image: string;
  command: string[];
  requirements: Record<string, unknown>;
  outputs: { evidence?: string[]; artifacts?: string[] };
  inputs_evidence?: Array<{ path: string; content: string }>;
  workspace_subdir?: string | null;
  timeout_s: number;
  attempt?: number;
  repo?: string;
  branch?: string;
  base_sha?: string;
  activity?: string;
}

export function parseTags(spec: string): Record<string, string | number | boolean> {
  const tags: Record<string, string | number | boolean> = {};
  for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [k, v] = part.split(":");
    if (v === undefined) tags[k] = true;
    else if (/^\d+(\.\d+)?$/.test(v)) tags[k] = Number(v);
    else tags[k] = v;
  }
  return tags;
}

async function hub(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${getHub()}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
}

function sh(cmd: string, args: string[], opts: { cwd?: string; timeout?: number } = {}): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(cmd, args, {
      cwd: opts.cwd,
      timeout: opts.timeout,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e: any) {
    return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? e.message };
  }
}

/** Cap file content at `max` bytes WITHOUT cutting mid-line (artifacts are
 * line-oriented JSON; a mid-JSON cut produces invalid collected files). */
function capAtLineBoundary(content: string, max: number): string {
  if (content.length <= max) return content;
  const cut = content.lastIndexOf("\n", max);
  return content.slice(0, cut > 0 ? cut : max);
}

/** Minimal, explicit environment for job subprocesses (never the worker's own env). */
function workloadEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: "/tmp",
    LANG: "C.UTF-8",
  };
  // Explicit per-job env passthrough on the worker: JOB_ENV_FOO=bar -> FOO=bar.
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("JOB_ENV_") && v !== undefined) env[k.slice("JOB_ENV_".length)] = v;
  }
  return env;
}

export interface WorkloadHandle {
  done: Promise<{ exitCode: number; killed: boolean; timedOut: boolean }>;
  kill: (reason: "cancel" | "timeout") => void;
}

/**
 * Host one job workload as a detached subprocess group in `cwd`.
 * Cancel/timeout SIGKILLs the whole group (children cannot outlive the job).
 */
export function runWorkload(opts: {
  command: string[];
  cwd: string;
  timeout_s: number;
  onOutput?: (chunk: string, stream: "out" | "err") => void;
}): WorkloadHandle {
  const [cmd, ...args] = opts.command;
  let killed = false;
  let timedOut = false;
  let child: ReturnType<typeof spawn> | null = null;

  const killGroup = () => {
    if (child?.pid) {
      try {
        process.kill(-child.pid, "SIGKILL"); // negative pid = process group
      } catch {
        // already gone
      }
    }
  };

  const timer = setTimeout(() => {
    timedOut = true;
    killGroup();
  }, opts.timeout_s * 1000);

  const done = new Promise<{ exitCode: number; killed: boolean; timedOut: boolean }>((resolve) => {
    child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: workloadEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // own process group, so kills reach the whole tree
    });
    child.stdout?.on("data", (d) => opts.onOutput?.(String(d), "out"));
    child.stderr?.on("data", (d) => opts.onOutput?.(String(d), "err"));
    child.on("error", (e) => {
      opts.onOutput?.(`workload spawn error: ${e.message}\n`, "err");
      resolve({ exitCode: 127, killed, timedOut });
    });
    child.on("close", (code) => resolve({ exitCode: code ?? 1, killed, timedOut }));
  });

  return {
    done: done.finally(() => clearTimeout(timer)),
    kill: (reason) => {
      if (reason === "cancel") killed = true;
      else timedOut = true;
      killGroup();
    },
  };
}

let busy = false;
async function heartbeat(): Promise<void> {
  try {
    await hub("/api/nodes/heartbeat", {
      method: "POST",
      body: JSON.stringify({ id: NODE_ID, tags: NODE_TAGS, state: busy ? "busy" : "idle" }),
    });
  } catch {
    console.log(`[${NODE_ID}] heartbeat failed (hub unreachable)`);
  }
}

function originUrl(repo: string): string {
  const gitserver = process.env.GITSERVER_URL;
  if (!gitserver) throw new Error("GITSERVER_URL not configured (git-plane checkout)");
  let url = `${gitserver.replace(/\/$/, "")}/${repo}.git`;
  // Worker git token + internal CA apply to http(s) origins (the gitserver).
  const tokenFile = process.env.GIT_TOKEN_FILE;
  if (tokenFile && url.startsWith("http")) {
    const token = readFileSync(tokenFile, "utf8").trim();
    url = url.replace(/^(https?):\/\//, `$1://${encodeURIComponent(token)}@`);
  }
  return url;
}

/** Clone origin + check out the job's task branch (git plane, DESIGN §3.2.1). */
export function checkout(job: JobSpec): { dir: string; branch: string } {
  const workDir = resolve(process.env.WORK_DIR ?? "/work");
  const dir = join(workDir, job.id);
  mkdirSync(workDir, { recursive: true });
  rmSync(dir, { recursive: true, force: true });
  if (!job.branch) {
    throw new Error(`job ${job.id} carries no task branch (git-plane jobs need {repo, branch, base_sha})`);
  }
  const repo = job.repo ?? "demo";
  const url = originUrl(repo);
  let r = sh("git", ["clone", "--quiet", "--no-hardlinks", url, dir]);
  if (r.code !== 0) throw new Error(`git clone failed: ${r.stderr.slice(0, 500)}`);
  // Task refs live under refs/tasks/* — fetch explicitly and check out.
  r = sh("git", ["fetch", "--quiet", "origin", job.branch], { cwd: dir });
  if (r.code !== 0) throw new Error(`git fetch ${job.branch} failed: ${r.stderr.slice(0, 500)}`);
  r = sh("git", ["checkout", "--quiet", "-B", "work", "FETCH_HEAD"], { cwd: dir });
  if (r.code !== 0) throw new Error(`git checkout failed: ${r.stderr.slice(0, 500)}`);
  // Worker commits (results push) need an identity.
  sh("git", ["config", "user.name", `worker:${NODE_ID}`], { cwd: dir });
  sh("git", ["config", "user.email", `${NODE_ID}@workers.autoresearch`], { cwd: dir });
  return { dir, branch: job.branch };
}

/** Commit work products and push them to the job's task branch. */
export function commitAndPush(job: JobSpec, dir: string): { pushed: boolean; detail: string; sha?: string } {
  const repo = job.repo ?? "demo";
  const url = originUrl(repo);
  sh("git", ["remote", "set-url", "origin", url], { cwd: dir });
  sh("git", ["add", "-A"], { cwd: dir });
  const staged = sh("git", ["diff", "--cached", "--quiet"], { cwd: dir });
  if (staged.code === 0) return { pushed: false, detail: "nothing to commit" };
  let r = sh("git", ["commit", "--quiet", "-m", `job ${job.id}: results (attempt ${job.attempt ?? 1})`], { cwd: dir });
  if (r.code !== 0) return { pushed: false, detail: `commit failed: ${r.stderr.slice(0, 300)}` };
  if (!job.branch) return { pushed: false, detail: "no branch" };
  r = sh("git", ["push", "--quiet", "origin", `HEAD:${job.branch}`], { cwd: dir });
  if (r.code !== 0) return { pushed: false, detail: `push failed: ${r.stderr.replace(/https:\/\/[^@/]+@/g, "https://***@").slice(0, 300)}` };
  const sha = sh("git", ["rev-parse", "HEAD"], { cwd: dir }).stdout.trim();
  return { pushed: true, detail: "pushed", sha };
}

interface Tailer {
  stop(): void;
}

export function findProgressFiles(workspace: string): string[] {
  const r = sh("find", [workspace, "-name", "progress.jsonl", "-not", "-path", "*/.git/*"], {});
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

export function startProgressTail(job: JobSpec, workspace: string, onCancel: () => void): Tailer {
  // Jobs may emit progress.jsonl anywhere under the workspace (e.g. runs/<variant>/);
  // the runner discovers and tails all of them (protocols/README.md §2).
  // ONLY files the workload itself creates/modified: the checkout carries
  // COMMITTED progress files from earlier attempts (attempts append on the
  // same branch) — re-pumping those floods the hub and starves the terminal
  // status POST behind the fetch pool (root cause of the R4 wedge).
  // Baseline snapshot taken BEFORE the workload starts: the checkout carries
  // COMMITTED progress files from earlier attempts (git checkout gives them
  // fresh mtimes, so mtime cannot distinguish). Only content beyond the
  // baseline — new files or growth — belongs to this workload.
  const baseline = new Map<string, number>();
  for (const file of findProgressFiles(workspace)) {
    try {
      baseline.set(file, statSync(file).size);
    } catch {
      baseline.set(file, 0);
    }
  }
  const offsets = new Map<string, number>();
  let cancelled = false;
  const sendLine = async (line: string) => {
    try {
      const ev = JSON.parse(line);
      if (!ev.node) ev.node = NODE_ID; // ownership: hub rejects foreign event posts
      const res = await hub(`/api/jobs/${job.id}/events`, { method: "POST", body: JSON.stringify(ev) });
      if (res.ok) {
        const body = (await res.json()) as { cancel?: boolean };
        if (body.cancel && !cancelled) {
          cancelled = true;
          console.log(`[${NODE_ID}] job ${job.id}: cancellation requested by hub`);
          onCancel();
        }
      }
    } catch {
      console.log(`[${NODE_ID}] bad progress line: ${line.slice(0, 200)}`);
    }
  };
  const pump = async (file: string) => {
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      return;
    }
    // Committed baseline content is not this job's progress.
    const base = baseline.get(file);
    if (base !== undefined) {
      if (content.length <= base) return;
      content = content.slice(base);
    }
    const offset = offsets.get(file) ?? 0;
    if (content.length <= offset) return;
    offsets.set(file, content.length);
    for (const line of content.slice(offset).split("\n")) {
      const trimmed = line.trim();
      if (trimmed) await sendLine(trimmed);
    }
  };
  const timer = setInterval(() => {
    if (cancelled) return;
    for (const file of findProgressFiles(workspace)) {
      void pump(file);
    }
  }, 500);
  return {
    stop() {
      const wasCancelled = cancelled;
      cancelled = true;
      clearInterval(timer);
      // final flush of any lines written between the last tick and now —
      // but never after a cancellation (the job is being killed).
      if (!wasCancelled) {
        for (const file of findProgressFiles(workspace)) void pump(file);
      }
    },
  };
}

export async function executeJob(job: JobSpec): Promise<void> {
  busy = true;
  let checkoutDir = "";
  try {
    console.log(`[${NODE_ID}] executing ${job.id} (repo=${job.repo ?? "demo"}, branch=${job.branch ?? "?"})`);
    const co = checkout(job);
    checkoutDir = co.dir;
    const workspace = join(checkoutDir, job.workspace_subdir ?? "");
    if (!existsSync(workspace)) throw new Error(`workspace subdir missing: ${job.workspace_subdir}`);

    // Materialize upstream evidence into the checkout (cross-activity data flow).
    for (const file of job.inputs_evidence ?? []) {
      const dest = join(workspace, file.path);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, file.content);
      console.log(`[${NODE_ID}] job ${job.id}: materialized input ${file.path}`);
    }

    console.log(`[${NODE_ID}] hosting workload as subprocess (declared stack image: ${job.image})`);

    let handle: WorkloadHandle | null = null;
    const tailer = startProgressTail(job, workspace, () => {
      handle?.kill("cancel");
    });

    // Lease renewal: silent jobs (no progress.jsonl output) must not lose their
    // lease while genuinely running. Renew every 10s until terminal.
    // The renewal response carries the cancel flag — honor it so silent
    // jobs are cancellable without waiting for the timeout.
    const leaseTimer = setInterval(() => {
      void hub(`/api/jobs/${job.id}/status`, {
        method: "POST",
        body: JSON.stringify({ state: "running", attempt: job.attempt }),
      })
        .then(async (res) => {
          if (!res.ok) return;
          const body = (await res.json()) as { cancel?: boolean };
          if (body.cancel) {
            console.log(`[${NODE_ID}] job ${job.id}: cancellation requested by hub (lease renewal)`);
            handle?.kill("cancel");
          }
        })
        .catch(() => undefined);
    }, 10_000);

    const started = Date.now();
    handle = runWorkload({
      command: job.command,
      cwd: workspace,
      timeout_s: job.timeout_s ?? 3600,
      onOutput: (chunk, stream) =>
        (stream === "out" ? process.stdout : process.stderr).write(`[job ${job.id}] ${chunk}`),
    });
    const { exitCode, killed, timedOut } = await handle.done;
    tailer.stop();
    clearInterval(leaseTimer);

    const state = killed || timedOut ? "failed" : exitCode === 0 ? "succeeded" : "failed";
    const elapsed = Math.round((Date.now() - started) / 1000);
    console.log(`[${NODE_ID}] job ${job.id} exited code=${exitCode} state=${state} in ${elapsed}s (killed=${killed} timeout=${timedOut})`);

    // Let the final progress lines flush before collecting evidence.
    await new Promise((r) => setTimeout(r, 500));
    // Git plane: commit work products and push to the task branch (partial
    // dead work on failures stays visible for audit — attempts append).
    // R5: evidence IS the committed state — the pushed SHA travels with the
    // terminal status and gates read it from the bare repo (no uploads).
    const push = commitAndPush(job, checkoutDir);
    console.log(`[${NODE_ID}] job ${job.id}: task-branch push ${push.detail}`);
    const statusRes = await hub(`/api/jobs/${job.id}/status`, {
      method: "POST",
      body: JSON.stringify({ state, exit_code: exitCode, attempt: job.attempt, pushed_sha: push.sha ?? undefined }),
    });
    if (!statusRes.ok) {
      console.log(`[${NODE_ID}] job ${job.id}: terminal status POST rejected (${statusRes.status}) — attempt superseded`);
    }
  } finally {
    // Checkout lives exactly as long as the task (exit-after-task makes the
    // container ephemeral; nothing durable lives only in the worker).
    if (checkoutDir) rmSync(checkoutDir, { recursive: true, force: true });
    busy = false;
  }
}

async function main(): Promise<void> {
  console.log(
    `[${NODE_ID}] worker runner up (hub=${getHub()}, gitserver=${process.env.GITSERVER_URL ?? "UNSET"}, tags=${JSON.stringify(NODE_TAGS)})`,
  );
  setInterval(() => void heartbeat(), HEARTBEAT_MS);
  await heartbeat();

  for (;;) {
    try {
      if (!busy) {
        const res = await hub(`/api/work?node=${encodeURIComponent(NODE_ID)}`);
        if (res.status === 200) {
          const job = (await res.json()) as JobSpec;
          await executeJob(job).catch((e) => {
            console.log(`[${NODE_ID}] job execution error: ${e.message}`);
            void hub(`/api/jobs/${job.id}/status`, {
              method: "POST",
              body: JSON.stringify({ state: "failed", exit_code: 1, attempt: job.attempt }),
            });
          });
          continue; // immediately look for more work
        }
      }
    } catch (e) {
      console.log(`[${NODE_ID}] poll error: ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

// Auto-start guard: run the pull loop only when executed as the entrypoint
// (npm start / container CMD), not when imported by tests.
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

/** R4: fetch + rebase the task branch onto the instructed main and force-push
 * (the hook consumes the hub-granted one-time authorization server-side).
 */
export function rebaseOntoMain(opts: {
  dir: string;
  repo: string;
  branch: string;
  targetMainSha: string;
}): { ok: boolean; detail: string } {
  let r = sh("git", ["fetch", "--quiet", "origin", "main"], { cwd: opts.dir });
  if (r.code !== 0) return { ok: false, detail: `fetch main failed: ${r.stderr.slice(0, 300)}` };
  // Rebase THIS branch's commits onto the instructed main (upstream=target);
  // `--onto target HEAD` replays nothing and would DROP the task's work.
  r = sh("git", ["rebase", opts.targetMainSha], { cwd: opts.dir });
  if (r.code !== 0) {
    sh("git", ["rebase", "--abort"], { cwd: opts.dir });
    return { ok: false, detail: `rebase failed (conflict): ${r.stderr.slice(0, 300)}` };
  }
  sh("git", ["remote", "set-url", "origin", originUrl(opts.repo)], { cwd: opts.dir });
  r = sh("git", ["push", "--quiet", "--force", "origin", `HEAD:${opts.branch}`], { cwd: opts.dir });
  if (r.code !== 0) return { ok: false, detail: `push failed: ${r.stderr.replace(/https:\/\/[^@/]+@/g, "https://***@").slice(0, 300)}` };
  return { ok: true, detail: "rebased and force-pushed" };
}
