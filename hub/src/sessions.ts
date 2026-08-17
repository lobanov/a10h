/**
 * Worker sessions + SSE instruction channel (DESIGN.md §7.1, R4).
 *
 * Workers are uniform until they REGISTER: announcing at the well-known
 * endpoint issues a session id (scoped to the container lifetime) that makes
 * the worker addressable. Every hub-initiated worker instruction is an SSE
 * event on the session's own stream — work offers, gate feedback (consumed as
 * agent turn inputs), retrospective prompts, repair, rebase, cancel, and the
 * exit signal. Delivery is at-least-once with idempotent acks and a bounded
 * per-session buffer; each SSE connect delivers the full unacked buffer
 * (fresh buffer — no last-event-id). There is deliberately NO rescue: a
 * worker that dies mid-task loses its session; the lease expires and the job
 * requeues from scratch on the same branch.
 */
import { randomUUID } from "node:crypto";
import { pool } from "./db.ts";
import { bus } from "./bus.ts";
import { nodeMatches } from "./scheduler.ts";

export type InstructionKind =
  | "work_offer"
  | "gate_feedback"
  | "retrospective_prompt"
  | "repair"
  | "rebase"
  | "cancel"
  | "exit"
  | "custom";

export interface Instruction {
  id: number;
  kind: InstructionKind;
  payload: Record<string, unknown>;
}

const BUFFER_LIMIT = 100; // bounded per-session buffer (unacked instructions)

/** Register a worker: issue (or revive) its container-lifetime session id. */
export async function registerWorker(input: {
  node_id: string;
  tags?: Record<string, unknown>;
}): Promise<{ session_id: string; events_path: string }> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO worker_sessions (id, node_id, state) VALUES ($1, $2, 'idle')`,
    [id, input.node_id],
  );
  // Node row for capability matching + dashboard (same shape as heartbeats).
  await pool.query(
    `INSERT INTO nodes (id, tags, state, last_seen) VALUES ($1, $2, 'idle', now())
     ON CONFLICT (id) DO UPDATE SET tags = $2, last_seen = now()`,
    [input.node_id, JSON.stringify(input.tags ?? {})],
  );
  bus.publish("worker_session", { session_id: id, node: input.node_id, state: "registered" });
  return { session_id: id, events_path: `/api/worker-sessions/${id}/events` };
}

export async function touchSession(sessionId: string): Promise<boolean> {
  const r = await pool.query(
    `UPDATE worker_sessions SET last_seen = now() WHERE id = $1 RETURNING node_id`,
    [sessionId],
  );
  if ((r.rowCount ?? 0) > 0) {
    await pool.query(
      `INSERT INTO nodes (id, tags, state, last_seen) VALUES ($1, '{}', 'idle', now())
       ON CONFLICT (id) DO UPDATE SET last_seen = now()`,
      [r.rows[0].node_id],
    ).catch(() => undefined);
  }
  return (r.rowCount ?? 0) > 0;
}

export async function setSessionState(sessionId: string, state: string): Promise<void> {
  await pool.query(`UPDATE worker_sessions SET state = $1, last_seen = now() WHERE id = $2`, [
    state,
    sessionId,
  ]);
}

/**
 * Queue an instruction for a session (at-least-once). Returns the instruction
 * id, or null if the session is gone (its container exited) — callers treat
 * that as "no recipient" and fall back to lease-expiry semantics.
 */
export async function emitInstruction(
  sessionId: string,
  kind: InstructionKind,
  payload: Record<string, unknown>,
): Promise<number | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Bound the buffer: drop the OLDEST unacked instructions beyond the limit.
    await client.query(
      `DELETE FROM instruction_outbox WHERE id IN (
         SELECT id FROM instruction_outbox
         WHERE session_id = $1 AND acked_at IS NULL
         ORDER BY id DESC OFFSET $2
       )`,
      [sessionId, BUFFER_LIMIT],
    );
    const r = await client.query(
      `INSERT INTO instruction_outbox (session_id, kind, payload)
       VALUES ($1, $2, $3) RETURNING id`,
      [sessionId, kind, JSON.stringify(payload)],
    );
    await client.query("COMMIT");
    const id = r.rows[0].id as number;
    bus.publish("instruction", { session_id: sessionId, kind, instruction_id: id });
    return id;
  } catch {
    await client.query("ROLLBACK");
    return null;
  } finally {
    client.release();
  }
}

/** The full unacked buffer for a session (fresh buffer on every connect). */
export async function pendingInstructions(sessionId: string): Promise<Instruction[]> {
  const r = await pool.query(
    `SELECT id, kind, payload FROM instruction_outbox
     WHERE session_id = $1 AND acked_at IS NULL ORDER BY id ASC LIMIT $2`,
    [sessionId, BUFFER_LIMIT],
  );
  return r.rows as Instruction[];
}

export async function markDelivered(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await pool.query(
    `UPDATE instruction_outbox SET delivered_at = now()
     WHERE id = ANY($1::int[]) AND delivered_at IS NULL`,
    [ids],
  );
}

/** Idempotent ack: marking an already-acked instruction is a no-op success. */
export async function ackInstruction(
  sessionId: string,
  instructionId: number,
): Promise<boolean> {
  const r = await pool.query(
    `UPDATE instruction_outbox SET acked_at = now(), delivered_at = COALESCE(delivered_at, now())
     WHERE id = $1 AND session_id = $2 AND acked_at IS NULL RETURNING id`,
    [instructionId, sessionId],
  );
  return (r.rowCount ?? 0) > 0 || (await instructionExists(sessionId, instructionId));
}

async function instructionExists(sessionId: string, instructionId: number): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM instruction_outbox WHERE id = $1 AND session_id = $2 AND acked_at IS NOT NULL`,
    [instructionId, sessionId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** The live session for a node (streaming, not exited). */
export async function sessionForNode(nodeId: string): Promise<string | null> {
  const r = await pool.query(
    `SELECT id FROM worker_sessions
     WHERE node_id = $1 AND state <> 'exited' AND streaming
     ORDER BY created_at DESC LIMIT 1`,
    [nodeId],
  );
  return r.rows[0]?.id ?? null;
}

export async function setStreaming(sessionId: string, streaming: boolean): Promise<void> {
  await pool.query(`UPDATE worker_sessions SET streaming = $1 WHERE id = $2`, [
    streaming,
    sessionId,
  ]);
}

/** Idle sessions on nodes matching the job requirements (for offers). */
export async function idleSessionsForJob(
  requirements: Record<string, unknown>,
): Promise<Array<{ session_id: string; node_id: string }>> {
  // One task per container: only IDLE, streaming sessions are offerable.
  // Completed-but-not-yet-exited workers (busy) never take new offers;
  // zombie sessions (dead container) have streaming=false and are excluded.
  const sessions = await pool.query(
    `SELECT s.id AS session_id, s.node_id, n.tags
     FROM worker_sessions s JOIN nodes n ON n.id = s.node_id
     WHERE s.state = 'idle' AND s.streaming
     ORDER BY s.created_at ASC`,
  );
  return sessions.rows.filter((row) =>
    nodeMatches(row.tags as Record<string, string | number | boolean>, requirements),
  );
}

/**
 * Register-then-offer (R4): offer a queued job to an idle session. The job
 * moves to 'offered' (exclusive — one offer at a time); the worker's ack
 * converts the offer into a lease bound to its node.
 */
export async function offerJobToSession(
  jobId: string,
  sessionId: string,
): Promise<number | null> {
  const claimed = await pool.query(
    `UPDATE jobs SET status = 'offered', node = (SELECT node_id FROM worker_sessions WHERE id = $2),
       updated_at = now()
     WHERE id = $1 AND status = 'queued' RETURNING id`,
    [jobId, sessionId],
  );
  if ((claimed.rowCount ?? 0) === 0) return null;
  const full = await pool.query(`SELECT * FROM jobs WHERE id = $1`, [jobId]);
  const job = full.rows[0];
  return emitInstruction(sessionId, "work_offer", { job });
}

/** Worker acked a work_offer: bind the lease to its node (idempotent). */
export async function acceptOffer(jobId: string, sessionId: string, leaseSeconds: number): Promise<boolean> {
  const node = await pool.query(`SELECT node_id FROM worker_sessions WHERE id = $1`, [sessionId]);
  if (node.rows.length === 0) return false;
  const lease = new Date(Date.now() + leaseSeconds * 1000);
  const r = await pool.query(
    `UPDATE jobs SET status = 'leased', node = $1, lease_expires = $2, updated_at = now()
     WHERE id = $3 AND status IN ('offered', 'leased') RETURNING id`,
    [node.rows[0].node_id, lease, jobId],
  );
  if ((r.rowCount ?? 0) > 0) {
    await setSessionState(sessionId, "busy");
    bus.publish("job_status", { job_id: jobId, status: "leased", node: node.rows[0].node_id });
  }
  return (r.rowCount ?? 0) > 0;
}
