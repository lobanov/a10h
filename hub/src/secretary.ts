/**
 * Secretary agent duties (DESIGN.md §5.1, R6): work handoff, formal gate
 * verification, retention, and the worker exit signal. The verification LLM
 * turn lives in agents.ts (queueVerification); this module holds the
 * deterministic backbone the secretary always executes — LLM enrichment is
 * additive on top, never a dependency:
 *
 * - Work handoff: every work_offer carries the secretary's operational
 *   details (artifact paths/refs, branch, follow-up requests) — the director
 *   supplies commander's intent; the secretary operationalizes it.
 * - Retention: EVERY attempt (merged or closed) gets a summary note
 *   committed to main through the serialized per-repo writer, referencing
 *   the preserved task branch.
 * - Exit signal: the worker's container generation is released after its
 *   attempt merged AND the note landed (or the failed attempt closed + note).
 *
 * The secretary NEVER decides research direction (skill constraint).
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pool } from "./db.ts";
import { bus } from "./bus.ts";
import { withRepoLock, repoDir } from "./gitsvc.ts";

export interface HandoffDetails {
  role: "secretary";
  skill: "skills/secretary/SKILL.md";
  intent: string;
  branch: string;
  base_sha: string;
  artifact_paths: { evidence: string[]; artifacts: string[] };
  follow_ups: string[];
  constraints: string[];
}

/** Deterministic work handoff for a promoted job (secretary-authored). The
 * intent string carries the graph's title/expected outcome (the director's
 * commander's intent); everything else is operational. */
export function handoffFor(
  job: {
    branch?: string | null;
    base_sha?: string | null;
    outputs?: { evidence?: string[]; artifacts?: string[] } | null;
  },
  activity?: { title?: string; expected_outcome?: string } | null,
): HandoffDetails {
  const intentBits = [activity?.title, activity?.expected_outcome].filter(Boolean).join(" — ");
  return {
    role: "secretary",
    skill: "skills/secretary/SKILL.md",
    intent: intentBits || "Execute the assigned activity; evidence before claims.",
    branch: job.branch ?? "",
    base_sha: job.base_sha ?? "",
    artifact_paths: {
      evidence: job.outputs?.evidence ?? [],
      artifacts: job.outputs?.artifacts ?? [],
    },
    follow_ups: [
      "commit all declared outputs to the task branch",
      "write the exit retrospective when prompted (template arrives with the prompt)",
      "report the terminal status with the pushed SHA",
    ],
    constraints: [
      "never edit metrics to pass a gate — failing evidence goes through repair/escalation",
      "never decide research direction — operational specifics only",
    ],
  };
}

/** Log a secretary action (agent_log + bus) — the observable secretary. */
export async function logSecretary(event: string, data: unknown): Promise<void> {
  try {
    await pool.query(`INSERT INTO agent_log (role, event, data) VALUES ('secretary', $1, $2)`, [
      event,
      JSON.stringify(data),
    ]);
    bus.publish("agent", { role: "secretary", event, data });
  } catch {
    /* logging must never crash the hub */
  }
}

function sh(cmd: string, args: string[], opts: { cwd?: string } = {}): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(cmd, args, {
      cwd: opts.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e: any) {
    return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? e.message };
  }
}

/**
 * Retention (DESIGN §3.2.1): commit an attempt summary note to main for
 * every closed attempt — what was attempted, gate/verification outcome, and
 * the preserved task branch — through the serialized per-repo writer.
 */
export async function commitAttemptNote(input: {
  repo: string;
  planId: string;
  activity: string;
  attempt: number;
  outcome: "merged" | "passed_unmerged" | "failed_final" | "resolved" | "escalated";
  branch: string;
  tip?: string | null;
  detail?: string;
}): Promise<{ committed: boolean; note_path: string; main?: string }> {
  const safePlan = input.planId.replace(/[^A-Za-z0-9._-]/g, "-");
  const notePath = `notes/${safePlan}/${input.activity}/attempt-${input.attempt}.md`;
  const body =
    `# Attempt note — ${input.activity} (attempt ${input.attempt})\n\n` +
    `- plan: ${input.planId}\n` +
    `- activity: ${input.activity}\n` +
    `- outcome: ${input.outcome}\n` +
    `- task branch (preserved): ${input.branch}\n` +
    (input.tip ? `- branch tip: ${input.tip}\n` : "") +
    (input.detail ? `- detail: ${input.detail}\n` : "") +
    `\n_Auto-committed by the secretary (retention; DESIGN.md §3.2.1)._\n`;

  return withRepoLock(input.repo, async () => {
    // Notes land on main through the serialized writer WITHOUT transport:
    // a clone commits the note on current main, the bare FETCHES the commit
    // (fetch runs no receive-side hooks — the pre-receive policy denies main
    // pushes by design), and we fast-forward main under this lock.
    const gitDir = repoDir(input.repo);
    const wt = mkdtempSync(join(tmpdir(), "sec-note-"));
    try {
      const r = sh("git", ["clone", "-q", "--no-hardlinks", gitDir, wt]);
      if (r.code !== 0) { console.error("[secretary] note clone failed:", r.stderr.slice(0, 200)); return { committed: false, note_path: notePath }; }
      const noteFile = join(wt, notePath);
      mkdirSync(dirname(noteFile), { recursive: true });
      writeFileSync(noteFile, body);
      sh("git", ["add", "-A"], { cwd: wt });
      const c = sh("git", [
        "-c", "user.name=secretary", "-c", "user.email=secretary@autoresearch",
        "commit", "-q", "-m", `notes: ${input.activity} attempt ${input.attempt} (${input.outcome})`,
      ], { cwd: wt });
      if (c.code !== 0) { console.error("[secretary] note commit failed:", c.stderr.slice(0, 200)); await logSecretary("note_commit_failed", { err: c.stderr.slice(0,200) }); return { committed: false, note_path: notePath }; }
      const sha = sh("git", ["rev-parse", "HEAD"], { cwd: wt }).stdout.trim();
      // Fetch HEAD (a resolvable ref); raw-SHA fetches are refused by default.
      const f = sh("git", ["--git-dir", gitDir, "fetch", "-q", wt, "HEAD"]);
      if (f.code !== 0) { console.error("[secretary] note fetch failed:", f.stderr.slice(0, 200)); await logSecretary("note_fetch_failed", { err: f.stderr.slice(0,200) }); return { committed: false, note_path: notePath }; }
      // Fast-forward main to the note commit (we hold the repo lock; the
      // clone's main IS the bare's main from moments ago).
      const ff = sh("git", ["--git-dir", gitDir, "merge-base", "--is-ancestor", "main", sha]);
      if (ff.code !== 0) { console.error("[secretary] note not ff (main moved under the note)"); return { committed: false, note_path: notePath }; }
      const u = sh("git", ["--git-dir", gitDir, "update-ref", "refs/heads/main", sha]);
      if (u.code !== 0) { console.error("[secretary] note update-ref failed:", u.stderr.slice(0, 200)); return { committed: false, note_path: notePath }; }
      await logSecretary("note_committed", { ...input, note_path: notePath, main: sha });
      return { committed: true, note_path: notePath, main: sha };
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });
}
