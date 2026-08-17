/**
 * Hub git service (DESIGN.md §3.2.1): the git plane's brain.
 *
 * - Token policy: data/git/policy.json (written by scripts/bootstrap-git.sh),
 *   re-read per request so bootstrap changes apply without a hub restart.
 * - /internal/git/auth: nginx auth_request target — validates the pusher
 *   token for the repo and hands back the token/role as response headers.
 * - /internal/git/pre-receive: the thin hook's policy oracle. R1 scope:
 *   valid token required; workers push ONLY refs/tasks/*; main and any other
 *   ref denied; deletions and tags denied. (R2 adds job-scoped ref matching,
 *   fast-forward enforcement, one-time rebase authorizations.)
 * - Upstream sync: fetch the GitHub/upstream remote and fast-forward main
 *   through the serialized per-repo writer (operator write path).
 */
import { readFileSync, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { pool } from "./db.ts";
import { bus } from "./bus.ts";

// In-container: compose sets REPOS_DIR. On the host (BDD/e2e helpers): fall
// back to ./data/repos relative to cwd when present.
import { cwd } from "node:process";
const HOST_REPOS = join(cwd(), "data/repos");
const REPOS_DIR = process.env.REPOS_DIR ?? (existsSync(HOST_REPOS) ? HOST_REPOS : "/data/repos");
const POLICY_PATH = process.env.POLICY_PATH ?? "/data/git/policy.json";

export interface GitTokenInfo {
  role: string;
  node: string;
  repos: string[];
}

export interface PushLine {
  old: string;
  new: string;
  ref: string;
}

export interface PreReceiveVerdict {
  allow: boolean;
  messages: string[];
}

interface PolicyFile {
  version: number;
  tokens: Record<string, GitTokenInfo>;
}

/** Read the policy map; absent file = no tokens = everything denied. */
export function loadPolicy(): PolicyFile {
  try {
    const p = JSON.parse(readFileSync(POLICY_PATH, "utf8")) as PolicyFile;
    if (p && typeof p === "object" && p.tokens) return p;
  } catch {
    /* fallthrough */
  }
  return { version: 1, tokens: {} };
}

export function repoDir(repo: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(repo)) throw new Error("invalid repo name");
  return join(REPOS_DIR, `${repo}.git`);
}

/** Parse a Basic authorization header → [user, pass]. */
export function parseBasic(header: string): [string, string] | null {
  if (!header.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    if (idx < 0) return null;
    return [decoded.slice(0, idx), decoded.slice(idx + 1)];
  } catch {
    return null;
  }
}

/**
 * Validate a git HTTP request. `authorization` is the client's Basic header
 * (git embeds the token as the username for https://<token>@host URLs; when
 * prompted interactively it usually lands in the username too — accept either
 * side). Returns the token info or null.
 */
export function authenticateGit(
  authorization: string | undefined,
  repo: string,
): { token: string; info: GitTokenInfo } | null {
  const basic = parseBasic(authorization ?? "");
  if (!basic) return null;
  const candidate = basic[0] || basic[1];
  if (!candidate) return null;
  const info = loadPolicy().tokens[candidate];
  if (!info) return null;
  if (!info.repos.includes(repo)) return null;
  return { token: candidate, info };
}

const isZeroSha = (sha: string): boolean => /^0+$/.test(sha);

/**
 * Pre-receive policy (R1 baseline): structural rules that need no state.
 */
export function preReceivePolicy(
  token: string,
  info: GitTokenInfo,
  pushes: PushLine[],
): PreReceiveVerdict {
  const messages: string[] = [];
  for (const p of pushes) {
    const { ref, new: newSha } = p;
    if (isZeroSha(newSha)) {
      messages.push(`ref deletions are denied (${ref})`);
    } else if (ref === "refs/heads/main" || ref === "main") {
      messages.push("main is read-only for workers (merges + upstream sync only)");
    } else if (ref.startsWith("refs/tags/")) {
      messages.push("tag pushes are denied");
    } else if (!ref.startsWith("refs/tasks/")) {
      messages.push(`only refs/tasks/* may be pushed (got ${ref})`);
    }
  }
  if (messages.length > 0) return { allow: false, messages };
  return { allow: true, messages: [] };
}

export async function gitExec(
  gitDir: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string }> {
  return git(gitDir, args, extraEnv);
}

/**
 * Pre-receive policy (R2): the full thin-hook oracle. Enforces, per push:
 *   1. structural rules (R1 baseline)
 *   2. ref-match: the branch must belong to an ACTIVE job of this repo
 *   3. token-match: when the job is leased, the token's node must hold it
 *   4. fast-forward: old must be an ancestor of new (branch creation is
 *      hub-only — the hub pre-creates refs at promotion)
 *   5. non-ff pushes consume a one-time authorization atomically
 */
export async function preReceivePolicyFull(
  repo: string,
  token: string,
  info: GitTokenInfo,
  pushes: PushLine[],
  quarantine?: { obj_dir?: string; alt_dirs?: string },
): Promise<PreReceiveVerdict> {
  // Pushed objects live in git's quarantine dir during pre-receive; the
  // hook forwards it so new SHAs resolve hub-side.
  const qEnv: Record<string, string> = {};
  if (quarantine?.obj_dir) qEnv.GIT_OBJECT_DIRECTORY = quarantine.obj_dir;
  if (quarantine?.alt_dirs) qEnv.GIT_ALTERNATE_OBJECT_DIRECTORIES = quarantine.alt_dirs;
  const structural = preReceivePolicy(token, info, pushes);
  if (!structural.allow) return structural;
  const messages: string[] = [];
  let needForceGrant = false;
  for (const p of pushes) {
    const { ref, old: oldSha, new: newSha } = p;
    // 2. ref-match: an active job bound to this exact branch — or a job
    // that went terminal within the follow-up grace window (retrospectives
    // and other post-terminal pushes land on the same branch).
    const jobRow = await pool.query(
      `SELECT id, node, status FROM jobs
       WHERE repo = $1 AND branch = $2
         AND (status IN ('queued','leased','running')
              OR (status IN ('succeeded','failed','cancelled')
                  AND updated_at > now() - interval '30 minutes'))
       ORDER BY created_at DESC LIMIT 1`,
      [repo, ref],
    );
    if (jobRow.rowCount === 0) {
      messages.push(`no active job for ${ref} (branch not assigned or job closed)`);
      continue;
    }
    const job = jobRow.rows[0];
    // 3. token-match: any job bound to a node accepts pushes only from it
    //    (leased/running work, and grace-window follow-ups alike).
    if (job.node && job.node !== info.node) {
      messages.push(`${ref} belongs to a job held by node ${job.node}, not ${info.node}`);
      continue;
    }
    // 4/5. fast-forward unless a one-time grant covers this push
    if (isZeroSha(oldSha)) {
      messages.push(`${ref} must be pre-created by the hub (creation pushes denied)`);
      continue;
    }
    const ancestor = await git(repoDir(repo), ["merge-base", "--is-ancestor", oldSha, newSha], qEnv).then(
      () => true,
      () => false,
    );
    if (!ancestor) needForceGrant = true;
  }
  if (messages.length > 0) return { allow: false, messages };
  if (needForceGrant) {
    const consumed = await consumeForceAuth(repo, pushes.map((p) => p.ref));
    if (!consumed) {
      return {
        allow: false,
        messages: ["non-fast-forward push without a hub-granted one-time authorization"],
      };
    }
  }
  return { allow: true, messages: [] };
}

/** Grant a one-time force authorization for a branch (landing rebase turn). */
export async function grantForceAuth(repo: string, ref: string, jobId: string | null): Promise<number> {
  const r = await pool.query(
    `INSERT INTO git_force_auth (repo, ref, job_id) VALUES ($1,$2,$3) RETURNING id`,
    [repo, ref, jobId],
  );
  return r.rows[0].id as number;
}

/** Atomically consume ONE unconsumed, unexpired grant covering any ref. */
export async function consumeForceAuth(repo: string, refs: string[]): Promise<boolean> {
  for (const ref of refs) {
    const r = await pool.query(
      `UPDATE git_force_auth SET consumed_at = now()
       WHERE id = (
         SELECT id FROM git_force_auth
         WHERE repo = $1 AND ref = $2 AND consumed_at IS NULL AND expires_at > now()
         ORDER BY id DESC LIMIT 1 FOR UPDATE SKIP LOCKED
       )
       RETURNING id`,
      [repo, ref],
    );
    if ((r.rowCount ?? 0) > 0) return true;
  }
  return false;
}

/**
 * Pre-create the task branch for an activity at main's tip (promotion).
 * Refs are SCOPED to the plan (`refs/tasks/<plan>/<activity>`): activity ids
 * repeat across plan revisions and re-runs (DESIGN §3.2.1 — refs scoped per
 * graph revision); re-promotion within a plan reuses the ref (attempts
 * append), and the base is ALWAYS current main for a fresh plan.
 */
export async function createTaskBranch(
  repo: string,
  planId: string,
  activity: string,
): Promise<{ branch: string; base_sha: string }> {
  const branch = taskRef(planId, activity);
  return withRepoLock(repo, async () => {
    const dir = repoDir(repo);
    const existing = await git(dir, ["rev-parse", "--verify", "--quiet", branch]).then(
      (r) => r.stdout.trim(),
      () => "",
    );
    if (existing) return { branch, base_sha: existing };
    const mainSha = (await git(dir, ["rev-parse", "main"])).stdout.trim();
    await git(dir, ["update-ref", branch, mainSha]);
    bus.publish("git", { kind: "branch_created", repo, branch, base_sha: mainSha });
    return { branch, base_sha: mainSha };
  });
}

/** Task ref for an activity, scoped to its plan revision. */
export function taskRef(planId: string, activity: string): string {
  // Ref names may not contain some chars; sanitize the plan id.
  const safe = planId.replace(/[^A-Za-z0-9._-]/g, "-");
  return `refs/tasks/${safe}/${activity}`;
}

export interface LandingResult {
  repo: string;
  branch: string;
  outcome: "merged" | "held_rebase" | "nothing_to_merge";
  main?: string;
  instruction?: { id: number; target_main_sha: string; fresh: boolean };
}

const LANDING_STALL_S = Number(process.env.LANDING_STALL_TIMEOUT_S ?? 600);

/**
 * Landing turn (serialized per repo): ff-merge the task branch into main; if
 * main moved (non-ff), hold the branch, grant a one-time force authorization
 * and record a rebase instruction (delivered via SSE in R4). Stalled held
 * branches re-issue their instruction + grant after LANDING_STALL_TIMEOUT_S.
 */
export async function landBranch(
  repo: string,
  planId: string | null,
  activity: string,
  jobId?: string,
): Promise<LandingResult> {
  const branch = taskRef(planId ?? "adhoc", activity);
  return withRepoLock(repo, async () => {
    const dir = repoDir(repo);
    const tip = await git(dir, ["rev-parse", "--verify", "--quiet", branch]).then(
      (r) => r.stdout.trim(),
      () => "",
    );
    if (!tip) throw new Error(`no task branch ${branch} in ${repo}`);
    const mainSha = (await git(dir, ["rev-parse", "main"])).stdout.trim();
    if (tip === mainSha) return { repo, branch, outcome: "nothing_to_merge", main: mainSha };
    const ancestor = await git(dir, ["merge-base", "--is-ancestor", "main", branch]).then(
      () => true,
      () => false,
    );
    if (ancestor) {
      // Fast-forward: main advances to the branch tip.
      await git(dir, ["update-ref", "refs/heads/main", tip]);
      if (planId !== null) {
        await pool.query(
          `UPDATE activities SET merged_sha = $1, updated_at = now()
           WHERE plan_id = $2 AND id = $3`,
          [tip, planId, activity],
        );
      }
      bus.publish("git", { kind: "merged", repo, branch, main: tip });
      return { repo, branch, outcome: "merged", main: tip };
    }
    // Held: main moved under us — the owning worker must rebase (R4 delivers
    // the instruction; a fresh grant + instruction is issued each turn).
    await pool.query(`UPDATE rebase_instructions SET status = 'done', updated_at = now()
      WHERE repo = $1 AND branch = $2 AND status = 'held' AND created_at < now() - ($3 || ' seconds')::interval`,
      [repo, branch, String(LANDING_STALL_S)]).catch(() => undefined);
    const existing = await pool.query(
      `SELECT * FROM rebase_instructions WHERE repo=$1 AND branch=$2 AND status='held'
       AND updated_at > now() - ($3 || ' seconds')::interval ORDER BY id DESC LIMIT 1`,
      [repo, branch, String(LANDING_STALL_S)],
    );
    if ((existing.rowCount ?? 0) > 0) {
      const ins = existing.rows[0];
      return {
        repo, branch, outcome: "held_rebase",
        main: mainSha,
        instruction: { id: ins.id as number, target_main_sha: ins.target_main_sha, fresh: false },
      };
    }
    await grantForceAuth(repo, branch, jobId ?? null);
    const ins = await pool.query(
      `INSERT INTO rebase_instructions (repo, branch, job_id, target_main_sha)
       VALUES ($1,$2,$3,$4) RETURNING id, target_main_sha`,
      [repo, branch, jobId ?? null, mainSha],
    );
    bus.publish("git", { kind: "rebase_required", repo, branch, target_main_sha: mainSha });
    return {
      repo, branch, outcome: "held_rebase", main: mainSha,
      instruction: {
        id: ins.rows[0].id as number,
        target_main_sha: ins.rows[0].target_main_sha,
        fresh: true,
      },
    };
  });
}

// --- serialized per-repo writer (single-flight chain per repo) -------------
const repoLocks = new Map<string, Promise<unknown>>();

export function withRepoLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoLocks.get(repo) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  repoLocks.set(
    repo,
    next.catch(() => undefined),
  );
  return next;
}

function git(
  gitDir: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["--git-dir", gitDir, ...args],
      // Bounded: a wedged git must not poison the per-repo lock chain forever.
      { maxBuffer: 64 * 1024 * 1024, timeout: 60_000, env: { ...process.env, ...extraEnv } },
      (err, stdout, stderr) => (err ? reject(new Error(String(err.message || err))) : resolve({ stdout: String(stdout), stderr: String(stderr) })),
    );
  });
}

/**
 * Upstream sync (operator write path, DESIGN.md §3.2.1): fetch the upstream
 * (GitHub) remote and fast-forward local main to upstream/main. Non-ff
 * divergence is NOT auto-resolved — it surfaces as an error event.
 */
export async function syncUpstream(repo: string): Promise<{ synced: boolean; main: string }> {
  const dir = repoDir(repo);
  return withRepoLock(repo, async () => {
    const remotes = await git(dir, ["remote"]);
    if (!remotes.stdout.split("\n").includes("upstream")) {
      throw new Error(`no upstream remote configured for ${repo}`);
    }
    await git(dir, ["fetch", "upstream"]);
    const upstreamMain = (await git(dir, ["rev-parse", "upstream/main"])).stdout.trim();
    const localMain = (await git(dir, ["rev-parse", "main"])).stdout.trim();
    if (localMain === upstreamMain) return { synced: false, main: localMain };
    const ancestor = await git(dir, ["merge-base", "--is-ancestor", "main", "upstream/main"]).then(
      () => true,
      () => false,
    );
    if (!ancestor) {
      throw new Error(
        `upstream/main diverged from main (non-ff) — operator attention required: ${repo}`,
      );
    }
    await git(dir, ["update-ref", "refs/heads/main", upstreamMain]);
    return { synced: true, main: upstreamMain };
  });
}

export function reposDir(): string {
  return REPOS_DIR;
}

export function policyExists(): boolean {
  return existsSync(POLICY_PATH);
}
