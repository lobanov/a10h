import { pool } from "./db.ts";
import { bus } from "./bus.ts";
import { evaluateCriteria, type Criterion, type EvidenceFile } from "./gates.ts";
import { queueAudit, queueDirector } from "./agents.ts";
import { createTaskBranch, landBranch } from "./gitsvc.ts";
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
const MAX_GATE_ATTEMPTS = 2; // attempts per activity before escalation

const rand = () => Math.random().toString(36).slice(2, 6);

export async function tick(): Promise<void> {
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
        // Dependents proceed when the dependency passed, or was resolved/failed-final
        // after escalation (operator disposition) — recorded honestly on the activity.
        return dep && ["passed", "resolved", "failed_final"].includes(dep.status);
      });
      if (!depsOk) continue;
      const jobId = `${act.id}--a${act.attempt + 1}--${rand()}`;
      // R2: pre-create the task branch at main's tip; the job spec carries
      // {branch, base_sha}. Repair re-promotions reuse the existing ref
      // (attempts append on the same branch).
      const { branch, base_sha } = await createTaskBranch(repo, act.id);
      // Cross-activity data flow: materialize upstream activities' evidence
      // (e.g. training metrics.json) into this job's checkout pre-run.
      // Transitive closure: analysis needs baseline metrics even though it
      // only depends on variant-a/variant-b directly.
      const closure = new Set<string>();
      const collect = (id: string) => {
        for (const dep of (byId.get(id)?.depends_on as string[]) ?? []) {
          if (!closure.has(dep)) {
            closure.add(dep);
            collect(dep);
          }
        }
      };
      collect(act.id);
      const inputsEvidence: Array<{ path: string; content: string }> = [];
      for (const dep of closure) {
        const depRows = await pool.query(
          `SELECT a.path, a.content FROM artifacts a
           JOIN activities act2 ON act2.plan_id = $1 AND act2.id = $2 AND act2.job_id = a.job_id
           WHERE a.kind = 'evidence'`,
          [plan.id, dep],
        );
        for (const r of depRows.rows) {
          if (r.content !== null && !inputsEvidence.some((x) => x.path === r.path)) {
            inputsEvidence.push({ path: r.path, content: r.content });
          }
        }
      }
      await pool.query("BEGIN");
      try {
        await pool.query(
          `INSERT INTO jobs (id, plan_id, activity, image, command, requirements, outputs,
                             inputs_evidence, workspace_subdir, timeout_s, status, attempt,
                             repo, branch, base_sha)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'queued',$11,$12,$13,$14)`,
          [
            jobId,
            plan.id,
            act.id,
            act.job.image,
            JSON.stringify(act.job.command),
            JSON.stringify(act.job.requirements ?? {}),
            JSON.stringify(act.job.outputs ?? {}),
            JSON.stringify(inputsEvidence),
            plan.repo_subdir,
            act.job.timeout_s ?? 3600,
            act.attempt + 1,
            repo,
            branch,
            base_sha,
          ],
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
    await pool.query(
      `UPDATE activities SET status = 'gate_check', updated_at = now() WHERE plan_id = $1 AND id = $2`,
      [job.plan_id, job.activity],
    );
    await runGateEvaluation(job);
  }
}

export async function runGateEvaluation(job: {
  id: string;
  plan_id: string;
  activity: string;
  status: string;
}): Promise<void> {
  const actRow = await pool.query("SELECT * FROM activities WHERE plan_id = $1 AND id = $2", [job.plan_id, job.activity]);
  const act = actRow.rows[0];
  const evidenceRows = await pool.query(
    `SELECT path, content FROM artifacts WHERE job_id = $1 AND kind = 'evidence'`,
    [job.id],
  );
  const evidence: EvidenceFile[] = evidenceRows.rows.map((r) => ({ path: r.path, content: r.content }));
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
    `INSERT INTO gate_results (plan_id, activity, job_id, verdict, checks, reason)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [job.plan_id, job.activity, job.id, verdict, JSON.stringify(checks), reason],
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
  void queueAudit({ gateResultId, plan_id: job.plan_id, activity: job.activity, job_id: job.id, verdict, checks, evidence });
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
     JOIN gate_results gr ON gr.plan_id = a.plan_id AND gr.activity = a.id
     WHERE a.status = 'passed' AND a.merged_sha IS NULL AND gr.audit_note IS NOT NULL`,
  );
  const seen = new Set<string>();
  for (const row of rows.rows) {
    const key = `${row.plan_id}/${row.activity}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const repo = row.repo ?? "demo";
    try {
      const result = await landBranch(repo, row.plan_id, row.activity, row.job_id);
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
        result.instruction?.fresh && // emit once per stall window, not every tick
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
