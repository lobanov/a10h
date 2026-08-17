import { pool } from "./db.ts";
import { bus } from "./bus.ts";
import { evaluateCriteria, type Criterion, type EvidenceFile } from "./gates.ts";
import { queueAudit, queueDirector } from "./agents.ts";

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
  await requeueExpiredLeases();
  await promoteReadyActivities();
  await evaluateTerminalGates();
  await finalizePlans();
}

async function requeueExpiredLeases(): Promise<void> {
  const expired = await pool.query(
    `UPDATE jobs SET status = 'queued', node = NULL, lease_expires = NULL,
       attempt = attempt + 1, updated_at = now()
     WHERE status IN ('leased', 'running')
       AND lease_expires < now()
       AND attempt < $1
     RETURNING id, plan_id, activity, attempt`,
    [MAX_JOB_ATTEMPTS],
  );
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
  const plans = await pool.query("SELECT id, repo_subdir FROM plans WHERE status IN ('approved', 'executing')");
  for (const plan of plans.rows) {
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
                             inputs_evidence, workspace_subdir, timeout_s, status, attempt)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'queued',$11)`,
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
