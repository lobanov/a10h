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

const REPOS_DIR = process.env.REPOS_DIR ?? "/data/repos";
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
 * Pre-receive policy (R1). Workers may create/advance refs/tasks/* only;
 * everything else — main, other heads, tags, deletions — is denied.
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

function git(gitDir: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["--git-dir", gitDir, ...args],
      { maxBuffer: 64 * 1024 * 1024 },
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
    const remotes = await git(dir, "remote");
    if (!remotes.stdout.split("\n").includes("upstream")) {
      throw new Error(`no upstream remote configured for ${repo}`);
    }
    await git(dir, "fetch", "upstream");
    const upstreamMain = (await git(dir, "rev-parse", "upstream/main")).stdout.trim();
    const localMain = (await git(dir, "rev-parse", "main")).stdout.trim();
    if (localMain === upstreamMain) return { synced: false, main: localMain };
    const ancestor = await git(dir, "merge-base", "--is-ancestor", "main", "upstream/main").then(
      () => true,
      () => false,
    );
    if (!ancestor) {
      throw new Error(
        `upstream/main diverged from main (non-ff) — operator attention required: ${repo}`,
      );
    }
    await git(dir, "update-ref", "refs/heads/main", upstreamMain);
    return { synced: true, main: upstreamMain };
  });
}

export function reposDir(): string {
  return REPOS_DIR;
}

export function policyExists(): boolean {
  return existsSync(POLICY_PATH);
}
