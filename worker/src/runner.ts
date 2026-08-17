import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Worker runner (M3): pull work from the hub, execute job containers, relay
 * progress/events, upload evidence. Never accepts inbound connections.
 *
 * Env: HUB_URL, NODE_ID, NODE_TAGS, REPO_PATH, CHECKOUT_STRATEGY
 * (clone|worktree), WORK_DIR, HOST_WORK_DIR (host-visible path of WORK_DIR,
 * used for docker -v mounts since the docker daemon is the host's).
 */

function getHub(): string {
  return process.env.HUB_URL ?? "http://localhost:8080";
}
const NODE_ID = process.env.NODE_ID ?? `worker-${process.pid}`;
const NODE_TAGS = parseTags(process.env.NODE_TAGS ?? "cpu:4");
const REPO_PATH = resolve(process.env.REPO_PATH ?? "/repo");
const STRATEGY = process.env.CHECKOUT_STRATEGY === "worktree" ? "worktree" : "clone";
const WORK_DIR = resolve(process.env.WORK_DIR ?? "/work");
const HOST_WORK_DIR = process.env.HOST_WORK_DIR ?? WORK_DIR;
const POLL_MS = 1_000;
const HEARTBEAT_MS = 10_000;

interface JobSpec {
  id: string;
  image: string;
  command: string[];
  requirements: Record<string, unknown>;
  outputs: { evidence?: string[]; artifacts?: string[] };
  inputs_evidence?: Array<{ path: string; content: string }>;
  workspace_subdir?: string | null;
  timeout_s: number;
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

export function checkout(job: JobSpec): string {
  // Reads env lazily so tests can configure REPO_PATH/WORK_DIR/strategy per run.
  const REPO_PATH = resolve(process.env.REPO_PATH ?? "/repo");
  const WORK_DIR = resolve(process.env.WORK_DIR ?? "/work");
  const STRATEGY = process.env.CHECKOUT_STRATEGY === "worktree" ? "worktree" : "clone";
  const dir = join(WORK_DIR, job.id);
  mkdirSync(WORK_DIR, { recursive: true });
  rmSync(dir, { recursive: true, force: true });
  if (STRATEGY === "worktree") {
    // Requires the mounted repo to be writable; shares .git objects.
    // (safe.directory is set via global git config in the image; -c is ignored.)
    const r = sh("git", ["worktree", "add", "-f", dir, "HEAD"], { cwd: REPO_PATH });
    if (r.code !== 0) console.log(`[${NODE_ID}] worktree add failed, falling back to clone: ${r.stderr.slice(0, 300)}`);
    else return dir;
  }
  const r = sh("git", ["clone", "--quiet", "--no-hardlinks", REPO_PATH, dir]);
  if (r.code !== 0) throw new Error(`git clone failed: ${r.stderr.slice(0, 500)}`);
  return dir;
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
  const offsets = new Map<string, number>();
  let cancelled = false;
  const sendLine = async (line: string) => {
    try {
      const ev = JSON.parse(line);
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

async function collectAndUpload(job: JobSpec, workspace: string): Promise<void> {
  const body: { evidence: Array<{ path: string; content: string }>; artifacts: Array<{ path: string; content: string }> } = {
    evidence: [],
    artifacts: [],
  };
  for (const rel of job.outputs?.evidence ?? []) {
    const p = join(workspace, rel);
    if (existsSync(p)) body.evidence.push({ path: rel, content: readFileSync(p, "utf8").slice(0, 256 * 1024) });
    else console.log(`[${NODE_ID}] job ${job.id}: evidence file missing: ${rel}`);
  }
  for (const rel of job.outputs?.artifacts ?? []) {
    const p = join(workspace, rel);
    if (existsSync(p)) body.artifacts.push({ path: rel, content: readFileSync(p, "utf8").slice(0, 256 * 1024) });
  }
  const res = await hub(`/api/jobs/${job.id}/result`, { method: "POST", body: JSON.stringify(body) });
  if (!res.ok) console.log(`[${NODE_ID}] result upload failed: ${res.status}`);
}

async function executeJob(job: JobSpec): Promise<void> {
  busy = true;
  let checkoutDir = "";
  try {
    const container = `autoresearch-job-${job.id}`.replace(/[^a-zA-Z0-9_.-]/g, "-");
    console.log(`[${NODE_ID}] executing ${job.id} (${job.image})`);
    checkoutDir = checkout(job);
    const workspace = join(checkoutDir, job.workspace_subdir ?? "");
    if (!existsSync(workspace)) throw new Error(`workspace subdir missing: ${job.workspace_subdir}`);

    // Materialize upstream evidence into the checkout (cross-activity data flow).
    for (const file of job.inputs_evidence ?? []) {
      const dest = join(workspace, file.path);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, file.content);
      console.log(`[${NODE_ID}] job ${job.id}: materialized input ${file.path}`);
    }

    // Explicit pull so image fetch time is not billed to the job timeout.
    const pull = sh("docker", ["pull", job.image], { timeout: 600_000 });
    if (pull.code !== 0) console.log(`[${NODE_ID}] docker pull stderr: ${pull.stderr.slice(0, 300)}`);

    const hostCheckout = join(HOST_WORK_DIR, job.id);
    // Mount the *workspace* (checkout + project subdir) as /workspace so job
    // commands run at the project root (e.g. examples/demo-project).
    const hostWorkspace = join(hostCheckout, job.workspace_subdir ?? "");
    // Run job containers as the runner's uid by default so outputs remain
    // owned (and cleanable) by the runner. Opt out with RUN_AS_HOST_USER=0
    // for stacks that require root inside the container.
    const uidGid = `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`;
    const userArgs = (process.env.RUN_AS_HOST_USER ?? "1") === "1" ? ["-u", uidGid] : [];
    let containerProc: ReturnType<typeof spawn> | null = null;
    let killed = false;

    const tailer = startProgressTail(job, workspace, () => {
      killed = true;
      if (containerProc) sh("docker", ["kill", container]);
    });

    const timedOut = { value: false };
    const timeoutTimer = setTimeout(() => {
      timedOut.value = true;
      sh("docker", ["kill", container]);
    }, (job.timeout_s ?? 3600) * 1000);

    const started = Date.now();
    const exitCode = await new Promise<number>((resolveExit) => {
      containerProc = spawn("docker", [
        "run", "--rm", "--name", container,
        "-v", `${hostWorkspace}:/workspace`,
        ...userArgs,
        "-w", "/workspace",
        job.image, ...job.command,
      ]);
      containerProc.stdout?.on("data", (d) => process.stdout.write(`[job ${job.id}] ${d}`));
      containerProc.stderr?.on("data", (d) => process.stderr.write(`[job ${job.id}] ${d}`));
      containerProc.on("error", (e) => { console.log(`[${NODE_ID}] docker spawn error: ${e.message}`); resolveExit(1); });
      containerProc.on("close", (code) => resolveExit(code ?? 1));
    });
    clearTimeout(timeoutTimer);
    tailer.stop();

    const state = killed || timedOut.value ? "failed" : exitCode === 0 ? "succeeded" : "failed";
    const elapsed = Math.round((Date.now() - started) / 1000);
    console.log(`[${NODE_ID}] job ${job.id} exited code=${exitCode} state=${state} in ${elapsed}s (killed=${killed} timeout=${timedOut.value})`);

    // Let the final progress lines flush before collecting evidence.
    await new Promise((r) => setTimeout(r, 500));
    await collectAndUpload(job, workspace);
    await hub(`/api/jobs/${job.id}/status`, {
      method: "POST",
      body: JSON.stringify({ state, exit_code: exitCode }),
    });
  } finally {
    if (checkoutDir) rmSync(checkoutDir, { recursive: true, force: true });
    if (checkoutDir && STRATEGY === "worktree") sh("git", ["worktree", "prune"], { cwd: REPO_PATH });
    busy = false;
  }
}

async function main(): Promise<void> {
  console.log(`[${NODE_ID}] worker runner up (hub=${getHub()}, repo=${resolve(process.env.REPO_PATH ?? "/repo")}, strategy=${process.env.CHECKOUT_STRATEGY ?? "clone"}, tags=${JSON.stringify(NODE_TAGS)})`);
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
              body: JSON.stringify({ state: "failed", exit_code: 1 }),
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
