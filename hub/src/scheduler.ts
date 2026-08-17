import { pool } from "./db.ts";
import { bus } from "./bus.ts";
import { evaluateCriteria, type Criterion, type EvidenceFile } from "./gates.ts";
import { queueVerification, queueDirector, agentConfig } from "./agents.ts";
import { handoffFor, commitAttemptNote, logSecretary } from "./secretary.ts";
import {
  createTaskBranch,
  landBranch,
  readEvidenceAt,
  resolveEvidencePath,
  pathExistsAt,
  taskRef as taskRefOf,
  gitRevParse,
  gitIsAncestor,
  hubRebase,
} from "./gitsvc.ts";
import {
  offerJobToSession,
  idleSessionsForJob,
  sessionForNode,
  emitInstruction,
  setSessionState,
} from "./sessions.ts";

/**
 * Scheduler: runs every tick.
 *  1. Requeue jobs whose leases expired (runner death / partition).
 *  2. Promote ready activities to jobs for approved plans.
 *  3. Evaluate gates for jobs that reached a terminal state.
 *  4. Repair / escalate failed gates; resolve plan completion.
 */

export const LEASE_TTL_S = 30;
const MAX_JOB_ATTEMPTS = 3; // lease-expiry requeues per job
const MAX_GATE_ATTEMPTS = 3; // initial + two failed repairs, then escalation (DESIGN §5.2)

const rand = () => Math.random().toString(36).slice(2, 6);

let tickInFlight = false;
export async function tick(): Promise<void> {
  // Mutex: status-POST ticks and the interval tick must not interleave
  // (duplicate gate results, retrospective prompts, audits).
  if (tickInFlight) return;
  tickInFlight = true;
  try {
  await tickInner();
  } finally {
    tickInFlight = false;
  }
}

async function tickInner(): Promise<void> {
  const t0 = Date.now();
  const phase = async (name: string, fn: () => Promise<void>) => {
    const start = Date.now();
    const watchdog = setTimeout(() => {
      console.log(`[scheduler] WEDGED phase ${name} (${Date.now() - start}ms) — active handles:`);
      for (const h of (process as any)._getActiveHandles?.() ?? []) {
        const desc =
          h.constructor?.name ??
          String(h);
        const extra =
          typeof h.spawnfile === "string"
            ? ` spawnfile=${h.spawnfile} ${JSON.stringify(h.spawnargs ?? [])}`
            : typeof h.address === "function" && h.address
              ? ` ${JSON.stringify(h.address())}`
              : "";
        console.log(`  - ${desc}${extra}`);
      }
    }, 10_000) as ReturnType<typeof setTimeout>;
    try {
      await fn();
      if (Date.now() - start > 3000) console.log(`[scheduler] SLOW phase ${name}: ${Date.now() - start}ms`);
    } finally {
      clearTimeout(watchdog);
    }
  };
  await phase("pruneStaleNodes", pruneStaleNodes);
  await phase("requeueExpiredLeases", requeueExpiredLeases);
  await phase("promoteReadyActivities", promoteReadyActivities);
  await phase("offerQueuedJobs", offerQueuedJobs);
  await phase("evaluateTerminalGates", evaluateTerminalGates);
  await phase("landVerifiedActivities", landVerifiedActivities);
  await phase("finalizePlans", finalizePlans);
  if (Date.now() - t0 > 5000) console.log(`[scheduler] SLOW tick: ${Date.now() - t0}ms`);
}

/**
 * Register-then-offer (R4): queued jobs are offered to idle registered
 * sessions over their SSE instruction streams — replacing the work-pull
 * loop (GET /api/work stays as a demoted bootstrap/fallback path).
 */
async function offerQueuedJobs(): Promise<void> {
  const jobs = await pool.query(
    `SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 50`,
  );
  for (const job of jobs.rows) {
    const candidates = await idleSessionsForJob(
      job.requirements as Record<string, unknown>,
    );
    if (candidates.length === 0) continue;
    const offered = await offerJobToSession(job.id, candidates[0].session_id);
    if (offered !== null) {
      bus.publish("job_status", { job_id: job.id, status: "offered", session: candidates[0].session_id });
    }
  }
}

/** Remove nodes whose heartbeats stopped (stale registrations from redeployments). */
async function pruneStaleNodes(): Promise<void> {
  const stale = await pool.query(
    `DELETE FROM nodes WHERE last_seen < now() - interval '5 minutes' RETURNING id`,
  );
  for (const row of stale.rows) {
    bus.publish("node", { id: row.id, state: "gone" });
  }
}

async function requeueExpiredLeases(): Promise<void> {
  // Offers to dead sessions revert to queued (not an attempt failure).
  const expiredOffers = await pool.query(
    `UPDATE jobs SET status = 'queued', node = NULL, updated_at = now()
     WHERE status = 'offered' AND updated_at < now() - interval '30 seconds'
     RETURNING id, node`,
  );
  for (const row of expiredOffers.rows) {
    if (row.node) {
      await pool.query(
        `UPDATE worker_sessions SET state = 'idle' WHERE node_id = $1 AND state = 'busy'`,
        [row.node],
      );
    }
  }
  for (const row of expiredOffers.rows) {
    bus.publish("job_status", { job_id: row.id, status: "queued", reason: "offer_expired" });
  }
  const expired = await pool.query(
    `UPDATE jobs SET status = 'queued', node = NULL, lease_expires = NULL,
       attempt = attempt + 1, updated_at = now()
     WHERE status IN ('leased', 'running')
       AND lease_expires < now()
       AND attempt < $1
     RETURNING id, plan_id, activity, attempt, node`,
    [MAX_JOB_ATTEMPTS],
  );
  // The worker generation that held these jobs is gone (no rescue): release
  // its stuck-busy sessions so the node's next generation can take offers.
  for (const row of expired.rows) {
    if (row.node) {
      await pool.query(
        `UPDATE worker_sessions SET state = 'idle' WHERE node_id = $1 AND state = 'busy'`,
        [row.node],
      );
    }
  }
  for (const row of expired.rows) {
    bus.publish("job_status", { job_id: row.id, status: "queued", requeued: true, attempt: row.attempt });
  }
  const dead = await pool.query(
    `UPDATE jobs SET status = 'failed', exit_code = NULL, updated_at = now()
     WHERE status IN ('leased', 'running') AND lease_expires < now() AND attempt >= $1
     RETURNING id, plan_id, activity`,
    [MAX_JOB_ATTEMPTS],
  );
  for (const row of dead.rows) {
    bus.publish("job_status", { job_id: row.id, status: "failed", reason: "lease_expired_max_attempts" });
  }
}

/** True if the node's tags satisfy the job requirements (DESIGN.md §4 matching). */
export function nodeMatches(
  nodeTags: Record<string, string | number | boolean>,
  requirements: Record<string, unknown>,
): boolean {
  const gpu = requirements.gpu === true;
  if (gpu && !nodeTags.gpu) return false;
  const reqCpu = typeof requirements.cpu === "number" ? requirements.cpu : 0;
  const nodeCpu = typeof nodeTags.cpu === "number" ? nodeTags.cpu : reqCpu > 0 ? 0 : Infinity;
  if (reqCpu > nodeCpu) return false;
  for (const tag of (requirements.tags as string[]) ?? []) {
    if (!(tag in nodeTags)) return false;
  }
  return true;
}

async function promoteReadyActivities(): Promise<void> {
  const plans = await pool.query("SELECT id, repo_subdir, repo FROM plans WHERE status IN ('approved', 'executing')");
  for (const plan of plans.rows) {
    const repo = plan.repo ?? "demo";
    const acts = await pool.query("SELECT * FROM activities WHERE plan_id = $1", [plan.id]);
    const byId = new Map(acts.rows.map((a) => [a.id, a]));
    for (const act of acts.rows) {
      if (act.status !== "pending" && act.status !== "repair") continue;
      const deps = (act.depends_on as string[]) ?? [];
      const depsOk = deps.every((d) => {
        const dep = byId.get(d);
        if (!dep) return false;
        // Dependents build on MERGED main (DESIGN §3.2.1): a passed
        // dependency counts only once its audited-complete merge landed;
        // resolved/failed-final (operator disposition) also unblock.
        if (dep.status === "passed") return dep.merged_sha !== null;
        return ["resolved", "failed_final"].includes(dep.status);
      });
      if (!depsOk) continue;
      // M10 isolation: one failing promotion must not poison the tick's
      // later phases (gates/landing/sweeper) for every other plan.
      try {
        await promoteOneActivity(repo, plan, act);
      } catch (e) {
        console.error(`[scheduler] promote ${plan.id}/${act.id} failed:`, (e as Error).message);
      }
    }
  }
}

/** Audit-note verdict: true (agree_pass), false (dispute/agree_fail on a
 * passing gate), null (pending/unparseable). */
function auditNoteAgrees(note: unknown): boolean | null {
  if (typeof note !== "string" || !note) return null;
  try {
    const parsed = JSON.parse(note) as { verdict?: string };
    if (parsed.verdict === "agree_pass") return true;
    if (parsed.verdict === "dispute" || parsed.verdict === "agree_fail") return false;
    return null;
  } catch {
    return null;
  }
}

const MAX_REBASE_ROUNDS = 3;

/** Rebase instruction, once per stall window; after MAX_REBASE_ROUNDS the
 * landing escalates to the operator instead of looping forever (M6). */
async function maybeEmitRebaseInstruction(
  repo: string,
  planId: string,
  activity: string,
  jobId: string | null,
  branch: string,
): Promise<void> {
  const result = await landBranch(repo, planId, activity, jobId ?? undefined);
  if (result.outcome !== "held_rebase") return;
  const rounds = await pool.query(
    `SELECT count(*) c FROM rebase_instructions WHERE repo = $1 AND branch = $2`,
    [repo, branch],
  );
  if ((rounds.rows[0]?.c ?? 0) > MAX_REBASE_ROUNDS) {
    await createEscalation(planId, activity, 0,
      [{ id: "landing", ok: false, detail: `rebase rounds exhausted (${MAX_REBASE_ROUNDS})` }],
      "landing stalled: rebase rounds exhausted");
    return;
  }
  const nodeRow = jobId
    ? await pool.query(`SELECT node FROM jobs WHERE id = $1`, [jobId])
    : { rows: [] as Array<{ node?: string }> };
  const node = nodeRow.rows[0]?.node as string | undefined;
  const session = node ? await sessionForNode(node) : null;
  if (session && result.instruction?.fresh) {
    await emitInstruction(session, "rebase", {
      repo,
      branch,
      target_main_sha: result.instruction!.target_main_sha,
      job_id: jobId,
    });
    return;
  }
  // No live worker (generation exited) or within the stall window: hub-side
  // mechanical rebase (DESIGN §3.2.1 fallback; file-disjoint tasks).
  if (!session) {
    const rb = await hubRebase(repo, branch);
    if (!rb.ok && rb.detail !== "conflict") {
      // transient failure — the stall window retries
    }
  }
}

/** Promote one ready activity to a queued job (R2: pre-created task branch). */
async function promoteOneActivity(
  repo: string,
  plan: { id: string; repo_subdir: string | null },
  act: any,
): Promise<void> {
  const jobId = `${act.id}--a${act.attempt + 1}--${rand()}`;
  const { branch, base_sha } = await createTaskBranch(repo, plan.id, act.id);
  await pool.query("BEGIN");
  try {
    await pool.query(
      `INSERT INTO jobs (id, plan_id, activity, image, command, requirements, outputs,
                         workspace_subdir, timeout_s, status, attempt,
                         repo, branch, base_sha)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'queued',$10,$11,$12,$13)`,
      [
        jobId,
        plan.id,
        act.id,
        act.job.image,
        JSON.stringify(act.job.command),
        JSON.stringify(act.job.requirements ?? {}),
        JSON.stringify(act.job.outputs ?? {}),
        plan.repo_subdir,
        act.job.timeout_s ?? 3600,
        act.attempt + 1,
        repo,
        branch,
        base_sha,
      ].slice(0, 13),
    );
    await pool.query(
      `UPDATE activities SET status = 'running', attempt = $1, job_id = $2, updated_at = now()
       WHERE plan_id = $3 AND id = $4`,
      [act.attempt + 1, jobId, plan.id, act.id],
    );
    await pool.query(`UPDATE plans SET status = 'executing', updated_at = now() WHERE id = $1`, [plan.id]);
    await pool.query("COMMIT");
    bus.publish("job_status", { job_id: jobId, status: "queued", activity: act.id, plan_id: plan.id, attempt: act.attempt + 1 });
    bus.publish("activity", { plan_id: plan.id, activity: act.id, status: "running", attempt: act.attempt + 1 });
  } catch {
    await pool.query("ROLLBACK");
  }
}

async function evaluateTerminalGates(): Promise<void> {
  // Jobs terminal but not yet gate-checked (tracked via activity status running + job terminal).
  const rows = await pool.query(
    `SELECT j.* FROM jobs j
     JOIN activities a ON a.job_id = j.id AND a.status = 'running'
     WHERE j.status IN ('succeeded', 'failed', 'cancelled')`,
  );
  for (const job of rows.rows) {
    try {
      await pool.query(
        `UPDATE activities SET status = 'gate_check', updated_at = now() WHERE plan_id = $1 AND id = $2`,
        [job.plan_id, job.activity],
      );
      await runGateEvaluation(job);
    } catch (e) {
      // One failing gate evaluation must not strand the tick or other jobs.
      console.error(`[scheduler] gate eval ${job.plan_id}/${job.activity} failed:`, (e as Error).message);
      await pool.query(
        `UPDATE activities SET status = 'running', updated_at = now() WHERE plan_id = $1 AND id = $2`,
        [job.plan_id, job.activity],
      ).catch(() => undefined);
    }
  }
  // Recovery: activities stranded in gate_check (a prior throw between the
  // status update and the evaluation) are re-evaluated.
  const stranded = await pool.query(
    `SELECT j.id, j.plan_id, j.activity, j.status FROM activities a
     JOIN jobs j ON j.id = a.job_id
     WHERE a.status = 'gate_check' AND j.status IN ('succeeded','failed','cancelled')`,
  );
  for (const job of stranded.rows) {
    try {
      await runGateEvaluation(job);
    } catch {
      /* recovery is best-effort; the normal path logs */
    }
  }
}

export async function runGateEvaluation(job: {
  id: string;
  plan_id: string;
  activity: string;
  status: string;
}, shaOverride?: string): Promise<void> {
  const actRow = await pool.query("SELECT * FROM activities WHERE plan_id = $1 AND id = $2", [job.plan_id, job.activity]);
  const act = actRow.rows[0];
  // R5: evidence is COMMITTED state — read the declared outputs.evidence
  // files at the worker-reported SHA from the bare repo (no uploads, no
  // Postgres blobs, no tree-wide search).
  const jobRow = await pool.query(
    `SELECT repo, branch, base_sha, pushed_sha, outputs FROM jobs WHERE id = $1`,
    [job.id],
  );
  const jr = jobRow.rows[0] ?? {};
  const repo = (jr.repo as string) ?? "demo";
  const sha = shaOverride ?? (jr.pushed_sha as string) ?? (jr.base_sha as string) ?? null;
  const declared = ((jr.outputs as { evidence?: string[] })?.evidence ?? []) as string[];
  let evidence: EvidenceFile[] = [];
  if (sha) {
    try {
      evidence = await readEvidenceAt(repo, sha, declared);
    } catch (e) {
      console.error(`[scheduler] evidence read ${repo}@${sha.slice(0, 8)} failed:`, (e as Error).message);
    }
    // Lineage index rows (path <-> commit); content never enters Postgres.
    // Covers declared evidence AND artifacts (progress.jsonl etc.) —
    // existence-checked at the sha, content read only for gate evidence.
    for (const ev of evidence) {
      await pool.query(
        `INSERT INTO artifacts (job_id, kind, path, commit_sha) VALUES ($1, 'evidence', $2, $3)`,
        [job.id, ev.path, sha],
      ).catch(() => undefined);
    }
    const declaredArtifacts = ((jr.outputs as { artifacts?: string[] })?.artifacts ?? []) as string[];
    for (const p of declaredArtifacts) {
      const exists = await pathExistsAt(repo, sha, p);
      if (exists) {
        await pool.query(
          `INSERT INTO artifacts (job_id, kind, path, commit_sha) VALUES ($1, 'artifact', $2, $3)`,
          [job.id, p, sha],
        ).catch(() => undefined);
      }
    }
  }
  const gate = act.gate as { criteria?: Criterion[] } | null;

  let verdict: "pass" | "fail";
  let checks: Array<{ id: string; ok: boolean; detail: string }> = [];
  if (gate?.criteria?.length) {
    const result = evaluateCriteria(gate.criteria, job.status, evidence);
    verdict = result.verdict;
    checks = result.checks;
  } else {
    // No gate declared: job terminal state decides.
    verdict = job.status === "succeeded" ? "pass" : "fail";
    checks = [{ id: "job_state", ok: job.status === "succeeded", detail: `no gate declared; job status ${job.status}` }];
  }

  const reason =
    verdict === "pass"
      ? "all criteria met"
      : `failed criteria: ${checks.filter((c) => !c.ok).map((c) => c.id).join(", ")}`;

  const inserted = await pool.query(
    `INSERT INTO gate_results (plan_id, activity, job_id, verdict, checks, reason, evaluated_sha)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [job.plan_id, job.activity, job.id, verdict, JSON.stringify(checks), reason, sha],
  );
  const gateResultId = inserted.rows[0].id as number;
  bus.publish("gate", { gate_result_id: gateResultId, plan_id: job.plan_id, activity: job.activity, job_id: job.id, verdict, checks });

  if (verdict === "pass") {
    await pool.query(
      `UPDATE activities SET status = 'passed', updated_at = now() WHERE plan_id = $1 AND id = $2`,
      [job.plan_id, job.activity],
    );
    bus.publish("activity", { plan_id: job.plan_id, activity: job.activity, status: "passed", attempt: act.attempt });
    // R4: retrospective prompt as an instruction (canned until the secretary
    // owns it in R6) — the worker's agent consumes it as a turn input.
    // Retrospective prompts go out ONLY on the worker original submission
    // round (no shaOverride) — re-verification rounds must not re-prompt
    // (the append would move the tip and loop).
    if (!shaOverride) {
    const jobRow = await pool.query(`SELECT node FROM jobs WHERE id = $1`, [job.id]);
    const node = jobRow.rows[0]?.node as string | undefined;
    if (node) {
      const session = await sessionForNode(node);
      if (session) {
        await emitInstruction(session, "retrospective_prompt", {
          job_id: job.id,
          activity: job.activity,
          plan_id: job.plan_id,
          template: [
            "# Worker retrospective — <activity>",
            "- What worked: <thing that sped you up or avoided a failure>",
            "- What was fragile: <thing that almost broke or wasted time>",
            "- Lesson proposed: <concrete change to a skill, plan pattern, or job template>",
          ].join("\n"),
        });
      }
    }
    }
  } else {
    if (act.attempt < MAX_GATE_ATTEMPTS) {
      await pool.query(
        `UPDATE activities SET status = 'repair', updated_at = now() WHERE plan_id = $1 AND id = $2`,
        [job.plan_id, job.activity],
      );
      bus.publish("activity", {
        plan_id: job.plan_id,
        activity: job.activity,
        status: "repair",
        attempt: act.attempt,
        reason: "gate_failed_retry_scheduled",
      });
      // R4: gate feedback as an instruction — the worker's agent consumes the
      // findings as the turn input for its repair iteration.
      const jobRow = await pool.query(`SELECT node FROM jobs WHERE id = $1`, [job.id]);
      const node = jobRow.rows[0]?.node as string | undefined;
      if (node) {
        const session = await sessionForNode(node);
        if (session) {
          await emitInstruction(session, "gate_feedback", {
            job_id: job.id,
            activity: job.activity,
            plan_id: job.plan_id,
            verdict,
            failed_checks: checks.filter((c) => !c.ok),
            reason,
          });
        }
      }
    } else {
      await createEscalation(job.plan_id, job.activity, act.attempt, checks, reason);
    }
  }

  // Auditor agent reviews every gate outcome (reasonableness pass, M5).
  void queueVerification({ gateResultId, plan_id: job.plan_id, activity: job.activity, job_id: job.id, verdict, checks, evidence });
}

async function createEscalation(
  planId: string,
  activity: string,
  attempt: number,
  checks: Array<{ id: string; ok: boolean; detail: string }>,
  reason: string,
): Promise<void> {
  await pool.query(
    `UPDATE activities SET status = 'escalated', updated_at = now() WHERE plan_id = $1 AND id = $2`,
    [planId, activity],
  );
  const ap = await pool.query(
    `INSERT INTO approvals (kind, plan_id, activity, payload)
     VALUES ('escalation', $1, $2, $3) RETURNING id`,
    [
      planId,
      activity,
      JSON.stringify({
        activity,
        attempt,
        reason,
        failed_checks: checks.filter((c) => !c.ok),
        options: ["accept_failure", "retry"],
      }),
    ],
  );
  const id = ap.rows[0].id as number;
  bus.publish("activity", { plan_id: planId, activity, status: "escalated", attempt });
  bus.publish("approval", { id, kind: "escalation", plan_id: planId, activity, status: "pending" });
  // Director agent attaches a recommendation (M5).
  void queueDirector({ approvalId: id, plan_id: planId, activity, attempt, reason, failed_checks: checks.filter((c) => !c.ok) });
}

/** Operator resolves an escalation: accept_failure | retry. */
export async function resolveEscalation(approvalId: number, disposition: "accept_failure" | "retry"): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ap = await client.query("SELECT * FROM approvals WHERE id = $1 FOR UPDATE", [approvalId]);
    if (ap.rowCount === 0) throw new Error(`approval ${approvalId} not found`);
    const row = ap.rows[0];
    if (row.status !== "pending") throw new Error(`approval ${approvalId} is ${row.status}, not pending`);
    if (row.kind !== "escalation") throw new Error(`approval ${approvalId} is ${row.kind}, not escalation`);
    const newStatus = disposition === "accept_failure" ? "resolved" : "repair";
    await client.query(
      `UPDATE activities SET status = $1, updated_at = now() WHERE plan_id = $2 AND id = $3`,
      [newStatus, row.plan_id, row.activity],
    );
    await client.query(
      `UPDATE approvals SET status = 'resolved', resolution = $1, resolved_at = now() WHERE id = $2`,
      [JSON.stringify({ by: "operator", disposition }), approvalId],
    );
    await client.query("COMMIT");
    bus.publish("approval", { id: approvalId, kind: "escalation", plan_id: row.plan_id, activity: row.activity, status: "resolved", disposition });
    bus.publish("activity", { plan_id: row.plan_id, activity: row.activity, status: newStatus });
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/**
 * R2/R4 landing queue: activities whose gate PASSED and whose agent audit note
 * exists (verified-complete) merge to main through the serialized per-repo
 * writer. Non-ff branches are held with a rebase instruction + one-time
 * force grant, DELIVERED to the owning worker's session over SSE (R4; it
 * fetches, rebases onto target main, force-pushes with the grant, and the
 * next landing turn re-verifies). Merged/closed attempts emit the worker
 * EXIT signal (workers stay operational through their task's full cycle).
 */
async function landVerifiedActivities(): Promise<void> {
  const rows = await pool.query(
    `SELECT a.plan_id, a.id AS activity, a.job_id, p.repo, a.merged_sha
     FROM activities a
     JOIN plans p ON p.id = a.plan_id
     WHERE a.status = 'passed' AND a.merged_sha IS NULL`,
  );
  const seen = new Set<string>();
  for (const row of rows.rows) {
    const key = `${row.plan_id}/${row.activity}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const repo = row.repo ?? "demo";
    try {
      // Verified-complete means: latest gate_result is PASS, audited, AND
      // evaluated at EXACTLY the current branch tip (DESIGN §3.2.1 — merges
      // land exactly the verified SHA; a rebased/appended tip re-verifies).
      const tipRow = await pool.query(
        `SELECT evaluated_sha, verdict, audit_note FROM gate_results
         WHERE plan_id = $1 AND activity = $2 ORDER BY id DESC LIMIT 1`,
        [row.plan_id, row.activity],
      );
      const latest = tipRow.rows[0];
      const branch = taskRefOf(row.plan_id, row.activity);
      const tip = await gitRevParse(repo, branch);
      if (!tip) continue;
      const auditAgrees = auditNoteAgrees(latest?.audit_note);
      const agentsEnabled = agentConfig().enabled;
      const verified =
        latest &&
        latest.verdict === "pass" &&
        latest.evaluated_sha === tip &&
        // M3: the audit VERDICT gates the merge (dispute never merges);
        // with agents disabled, mechanical verification stands alone
        // (agents augment, never block — documented fallback).
        (agentsEnabled ? auditAgrees === true : true);
      if (!verified) {
        // WAIT state: this exact tip already passed the gate and the audit
        // is still pending — never re-gate a covered tip (audit latency
        // would duplicate rounds forever).
        if (latest && latest.verdict === "pass" && latest.evaluated_sha === tip && agentsEnabled && auditAgrees === null) {
          continue;
        }
        // M3: an audit DISPUTE on the covered tip escalates (never merges).
        if (auditAgrees === false) {
          await createEscalation(row.plan_id, row.activity, 0,
            [{ id: "audit", ok: false, detail: "audit disputed the gate verdict" }],
            "auditor disputed verification");
          continue;
        }
        // Tip NOT covered by the latest gate result: re-verify at the tip.
        const descendant = await gitIsAncestor(repo, "main", branch);
        if (descendant) {
          const jobRow2 = await pool.query(
            `SELECT id, plan_id, activity, status FROM jobs WHERE id = $1`,
            [row.job_id],
          );
          if (jobRow2.rows[0]) {
            await runGateEvaluation(jobRow2.rows[0], tip); // re-gate + re-audit at tip
          }
          continue; // NEVER merge in the same round as a fresh verification
        }
        // main diverged: rebase instruction (once per stall window; M6 caps).
        await maybeEmitRebaseInstruction(repo, row.plan_id, row.activity, row.job_id, branch);
        continue;
      }
      const result = await landBranch(repo, row.plan_id, row.activity, row.job_id, row.job_id ? tip : undefined);
      bus.publish("activity", {
        plan_id: row.plan_id,
        activity: row.activity,
        status: result.outcome === "merged" ? "landed" : "landing_held",
        landing: result,
      });
      const jobRow = await pool.query(`SELECT node FROM jobs WHERE id = $1`, [row.job_id]);
      const node = jobRow.rows[0]?.node as string | undefined;
      const session = node ? await sessionForNode(node) : null;
      if (result.outcome === "merged" || result.outcome === "nothing_to_merge") {
        if (session) {
          await emitInstruction(session, "exit", {
            reason: "post_merge",
            activity: row.activity,
            plan_id: row.plan_id,
          });
          await setSessionState(session, "exited");
        }
      } else if (
        result.outcome === "held_rebase" &&
        result.instruction?.fresh &&
        session
      ) {
        await emitInstruction(session, "rebase", {
          repo,
          branch: result.branch,
          target_main_sha: result.instruction.target_main_sha,
          job_id: row.job_id,
        });
      }
    } catch (e) {
      console.error(`[scheduler] landing ${key} failed:`, (e as Error).message);
    }
  }
  // R6 secretary retention: a summary note on main for every closed attempt
  // (merged or failed/resolved), once per attempt. Notes go through the
  // serialized per-repo writer (fetch + ff update-ref — no transport hooks).
  {
    const closed = await pool.query(
      `SELECT a.plan_id, a.id AS activity, a.attempt, a.job_id, a.merged_sha, p.repo, a.status
       FROM activities a JOIN plans p ON p.id = a.plan_id
       WHERE a.status IN ('passed','resolved','failed_final','escalated')
         AND NOT EXISTS (
           SELECT 1 FROM artifacts n
           WHERE n.job_id = a.job_id AND n.kind = 'note' AND n.path LIKE 'notes/%'
         )`,
    );
    for (const row of closed.rows) {
      const merged = row.merged_sha !== null;
      if (row.status === "passed" && !merged) continue; // note waits for the merge
      const branch = taskRefOf(row.plan_id, row.activity);
      const tip = await gitRevParse(row.repo ?? "demo", branch);
      const note = await commitAttemptNote({
        repo: row.repo ?? "demo",
        planId: row.plan_id,
        activity: row.activity,
        attempt: row.attempt,
        outcome: merged ? "merged" : (row.status as "failed_final" | "resolved" | "escalated"),
        branch,
        tip,
        detail: `activity ${row.status}`,
      });
      if (note.committed) {
        await pool.query(
          `INSERT INTO artifacts (job_id, kind, path, commit_sha) VALUES ($1, 'note', $2, $3)`,
          [row.job_id, note.note_path, note.main],
        ).catch(() => undefined);
      }
    }
  }

  // Generation release sweeper: a live busy session whose node has NO work
  // pending (no offered/leased/running jobs) and served its task will never
  // receive another instruction for this container generation — release it
  // (exit + restart makes the node available as a fresh generation). This
  // self-heals every post-task case: post-merge, attempt closure, retries
  // executed by a newer generation, one-shot exits already consumed.
  const releasable = await pool.query(
    `SELECT DISTINCT s.id, s.node_id FROM worker_sessions s
     WHERE s.state = 'busy' AND s.streaming
       AND NOT EXISTS (
         SELECT 1 FROM jobs j
         WHERE j.node = s.node_id AND j.status IN ('offered', 'leased', 'running')
       )`,
  );
  for (const row of releasable.rows) {
    await emitInstruction(row.id, "exit", { reason: "no_pending_work", node: row.node_id });
    await setSessionState(row.id, "exited");
    bus.publish("worker_session", { session_id: row.id, node: row.node_id, state: "released" });
  }

  // Attempt-closure exits: failed_final/resolved activities release their
  // worker — ONCE per activity (exit_signaled_at), never to future sessions.
  const closed = await pool.query(
    `SELECT a.plan_id, a.id AS activity, a.job_id FROM activities a
     WHERE a.status IN ('resolved', 'failed_final') AND a.exit_signaled_at IS NULL`,
  );
  for (const row of closed.rows) {
    const jobRow = await pool.query(`SELECT node FROM jobs WHERE id = $1`, [row.job_id]);
    const node = jobRow.rows[0]?.node as string | undefined;
    const session = node ? await sessionForNode(node) : null;
    await pool.query(
      `UPDATE activities SET exit_signaled_at = now() WHERE plan_id = $1 AND id = $2 AND exit_signaled_at IS NULL`,
      [row.plan_id, row.activity],
    );
    if (session) {
      await emitInstruction(session, "exit", {
        reason: "attempt_closed",
        activity: row.activity,
        plan_id: row.plan_id,
      });
      await setSessionState(session, "exited");
    }
  }
}

async function finalizePlans(): Promise<void> {
  const plans = await pool.query("SELECT id FROM plans WHERE status = 'executing'");
  for (const plan of plans.rows) {
    const acts = await pool.query("SELECT status FROM activities WHERE plan_id = $1", [plan.id]);
    const terminal = acts.rows.every((a) => ["passed", "resolved", "failed_final"].includes(a.status));
    if (terminal && acts.rows.length > 0) {
      await pool.query(`UPDATE plans SET status = 'done', updated_at = now() WHERE id = $1`, [plan.id]);
      bus.publish("plan", { plan_id: plan.id, status: "done" });
    }
  }
}
