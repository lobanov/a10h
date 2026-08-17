import yaml from "js-yaml";
import { pool } from "./db.ts";
import { bus } from "./bus.ts";

/** Planning graph: parse, validate DAG, persist plan + activities (pending approval). */

export interface GraphJob {
  image: string;
  command: string[];
  requirements?: Record<string, unknown>;
  outputs?: { evidence?: string[]; artifacts?: string[] };
  timeout_s?: number;
}

export interface GraphGate {
  id: string;
  criteria: Array<{ id: string; description?: string; check: Record<string, unknown> }>;
  evidence?: string[];
  auditor_skill?: string;
}

export interface GraphActivity {
  title?: string;
  description?: string;
  depends_on: string[];
  job: GraphJob;
  exit_gate?: GraphGate;
  expected_outcome?: string;
}

export interface Graph {
  goal_ref?: string;
  version?: number;
  status?: string;
  activities: Record<string, GraphActivity>;
}

export class PlanError extends Error {}

export function parseGraph(graphYaml: string): Graph {
  let graph: Graph;
  try {
    graph = yaml.load(graphYaml) as Graph;
  } catch (e) {
    throw new PlanError(`invalid YAML: ${(e as Error).message}`);
  }
  if (!graph || typeof graph !== "object" || !graph.activities || typeof graph.activities !== "object") {
    throw new PlanError("graph must be an object with an `activities` map");
  }
  for (const [id, act] of Object.entries(graph.activities)) {
    if (!act.job || !Array.isArray(act.job.command) || act.job.command.length === 0) {
      throw new PlanError(`activity "${id}" must define job.command (non-empty array)`);
    }
    if (!act.job.image) throw new PlanError(`activity "${id}" must define job.image`);
    if (!Array.isArray(act.depends_on ?? [])) throw new PlanError(`activity "${id}" depends_on must be an array`);
    for (const dep of act.depends_on ?? []) {
      if (!(dep in graph.activities)) throw new PlanError(`activity "${id}" depends on unknown activity "${dep}"`);
    }
    const gate = act.exit_gate;
    if (gate && !Array.isArray(gate.criteria)) {
      throw new PlanError(`activity "${id}" exit_gate.criteria must be an array`);
    }
  }
  // cycle detection
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (id: string, stack: string[]) => {
    if (done.has(id)) return;
    if (visiting.has(id)) throw new PlanError(`dependency cycle: ${[...stack, id].join(" -> ")}`);
    visiting.add(id);
    for (const dep of graph.activities[id].depends_on ?? []) visit(dep, [...stack, id]);
    visiting.delete(id);
    done.add(id);
  };
  for (const id of Object.keys(graph.activities)) visit(id, []);
  return graph;
}

export async function submitPlan(input: {
  name: string;
  graphYaml: string;
  repo?: string;
  repoSubdir?: string;
}): Promise<{ planId: string; approvalId: number }> {
  const graph = parseGraph(input.graphYaml);
  const planId = input.name;
  const existing = await pool.query("SELECT id FROM plans WHERE id = $1", [planId]);
  if (existing.rowCount && existing.rowCount > 0) {
    throw new PlanError(`plan "${planId}" already exists`);
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO plans (id, name, goal_ref, repo_subdir, repo, graph, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending_approval')`,
      [planId, input.name, graph.goal_ref ?? null, input.repoSubdir ?? null, input.repo ?? "demo", JSON.stringify(graph)],
    );
    for (const [id, act] of Object.entries(graph.activities)) {
      await client.query(
        `INSERT INTO activities (plan_id, id, title, depends_on, job, gate, expected_outcome, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')`,
        [
          planId,
          id,
          act.title ?? id,
          JSON.stringify(act.depends_on ?? []),
          JSON.stringify(act.job),
          act.exit_gate ? JSON.stringify(act.exit_gate) : null,
          act.expected_outcome ?? null,
        ],
      );
    }
    const approval = await client.query(
      `INSERT INTO approvals (kind, plan_id, payload)
       VALUES ('plan_approval', $1, $2) RETURNING id`,
      [planId, JSON.stringify({ plan: input.name, activities: Object.keys(graph.activities).length })],
    );
    await client.query("COMMIT");
    const approvalId = approval.rows[0].id as number;
    bus.publish("plan", { plan_id: planId, status: "pending_approval" });
    bus.publish("approval", { id: approvalId, kind: "plan_approval", plan_id: planId, status: "pending" });
    return { planId, approvalId };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/** Approve a pending plan approval: unblocks the scheduler. */
export async function approvePlan(approvalId: number, approve: boolean): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ap = await client.query("SELECT * FROM approvals WHERE id = $1 FOR UPDATE", [approvalId]);
    if (ap.rowCount === 0) throw new PlanError(`approval ${approvalId} not found`);
    const row = ap.rows[0];
    if (row.status !== "pending") throw new PlanError(`approval ${approvalId} is ${row.status}, not pending`);
    if (row.kind !== "plan_approval") throw new PlanError(`approval ${approvalId} is ${row.kind}, not plan_approval`);
    const planId = row.plan_id as string;
    await client.query(
      `UPDATE approvals SET status = $1, resolved_at = now(),
       resolution = $2 WHERE id = $3`,
      [approve ? "approved" : "rejected", JSON.stringify({ by: "operator", action: approve ? "approve" : "reject" }), approvalId],
    );
    await client.query(
      `UPDATE plans SET status = $1, updated_at = now() WHERE id = $2`,
      [approve ? "approved" : "blocked", planId],
    );
    await client.query("COMMIT");
    bus.publish("approval", { id: approvalId, kind: "plan_approval", plan_id: planId, status: approve ? "approved" : "rejected" });
    bus.publish("plan", { plan_id: planId, status: approve ? "approved" : "blocked" });
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
