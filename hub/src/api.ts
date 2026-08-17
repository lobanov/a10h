import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./db.ts";
import { bus } from "./bus.ts";
import { submitPlan, approvePlan, PlanError } from "./plans.ts";
import { tick, LEASE_TTL_S, nodeMatches, resolveEscalation } from "./scheduler.ts";

/**
 * Hub HTTP API (DESIGN.md §3.2, §4). Pull-only hub-spoke: spokes call
 * /api/nodes/heartbeat, /api/work, /api/jobs/:id/*; dashboard uses /api/state
 * and /api/stream (SSE). Auth: if AUTH_TOKEN is set, every request must carry
 * it via Authorization: Bearer or ?token= (EventSource cannot set headers).
 */

const AUTH_TOKEN = process.env.AUTH_TOKEN ?? "";
const MAX_BODY = 5 * 1024 * 1024;

function authorized(req: IncomingMessage, url: URL): boolean {
  if (!AUTH_TOKEN) return true;
  const header = req.headers.authorization ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  const query = url.searchParams.get("token") ?? "";
  return bearer === AUTH_TOKEN || query === AUTH_TOKEN;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function badProgressLine(ev: unknown): string | null {
  const e = ev as Record<string, unknown>;
  if (typeof e.t !== "number") return "t must be a number";
  if (typeof e.pct !== "number" || e.pct < 0 || e.pct > 100) return "pct must be within 0..100";
  if (typeof e.stage !== "string" || !e.stage) return "stage must be a non-empty string";
  if (e.state !== undefined && !["succeeded", "failed"].includes(e.state as string)) return "invalid state";
  return null;
}

export function createHttpServer(): ReturnType<typeof createServer> {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const route = `${req.method} ${url.pathname}`;
    try {
      if (!authorized(req, url)) return json(res, 401, { error: "unauthorized" });

      // ---------- health ----------
      if (route === "GET /api/health") return json(res, 200, { ok: true });

      // ---------- SSE stream ----------
      if (route === "GET /api/stream") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const since = Number(url.searchParams.get("since") ?? req.headers["last-event-id"] ?? 0);
        if (since > 0) for (const e of bus.replaySince(since)) {
          res.write(`id: ${e.id}\nevent: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
        }
        res.write(`event: hello\ndata: ${JSON.stringify({ since })}\n\n`);
        const unsub = bus.subscribe((e) => {
          res.write(`id: ${e.id}\nevent: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
        });
        const keepalive = setInterval(() => res.write(`: ping\n\n`), 15_000);
        req.on("close", () => {
          clearInterval(keepalive);
          unsub();
        });
        return;
      }

      // ---------- dashboard state snapshot ----------
      if (route === "GET /api/state") {
        const [plans, activities, jobs, latestEvents, nodes, approvals, gates, agents] = await Promise.all([
          pool.query("SELECT id, name, status, created_at FROM plans ORDER BY created_at DESC"),
          pool.query("SELECT plan_id, id, title, status, attempt, job_id, updated_at, depends_on FROM activities ORDER BY plan_id, id"),
          pool.query("SELECT id, plan_id, activity, status, node, attempt, exit_code, created_at, updated_at FROM jobs ORDER BY created_at DESC LIMIT 200"),
          pool.query(
            `SELECT DISTINCT ON (job_id) job_id, pct, eta_s, stage, state, t
             FROM job_events ORDER BY job_id, seq DESC`,
          ),
          pool.query("SELECT id, tags, state, last_seen FROM nodes ORDER BY id"),
          pool.query("SELECT id, kind, plan_id, activity, payload, agent_note, status, resolution, created_at, resolved_at FROM approvals ORDER BY id DESC LIMIT 50"),
          pool.query("SELECT id, plan_id, activity, verdict, checks, reason, audit_note, created_at FROM gate_results ORDER BY id DESC LIMIT 50"),
          pool.query("SELECT id, role, event, data, created_at FROM agent_log ORDER BY id DESC LIMIT 50"),
        ]);
        const latest = new Map(latestEvents.rows.map((r) => [r.job_id, r]));
        return json(res, 200, {
          plans: plans.rows,
          activities: activities.rows,
          jobs: jobs.rows.map((j) => ({ ...j, latest_event: latest.get(j.id) ?? null })),
          nodes: nodes.rows,
          approvals: approvals.rows,
          gate_results: gates.rows,
          agent_log: agents.rows,
          agents_configured: Boolean(process.env.Z_AI_API_KEY || process.env.LOCAL_LLM_BASE_URL),
        });
      }

      // ---------- plans ----------
      if (route === "POST /api/plans") {
        const body = JSON.parse((await readBody(req)).toString("utf8")) as {
          name?: string;
          graph_yaml?: string;
          repo_subdir?: string;
        };
        if (!body.name || !body.graph_yaml) return json(res, 400, { error: "name and graph_yaml required" });
        const { planId, approvalId } = await submitPlan({
          name: body.name,
          graphYaml: body.graph_yaml,
          repoSubdir: body.repo_subdir,
        });
        return json(res, 201, { plan_id: planId, approval_id: approvalId });
      }

      // ---------- approvals ----------
      const approvalMatch = url.pathname.match(/^\/api\/approvals\/(\d+)$/);
      if (approvalMatch && req.method === "POST") {
        const id = Number(approvalMatch[1]);
        const body = JSON.parse((await readBody(req)).toString("utf8")) as {
          action?: string;
          disposition?: string;
        };
        if (body.action === "approve") {
          await approvePlan(id, true);
          return json(res, 200, { ok: true, action: "approve" });
        }
        if (body.action === "reject") {
          await approvePlan(id, false);
          return json(res, 200, { ok: true, action: "reject" });
        }
        if (body.action === "resolve") {
          const disp = body.disposition === "retry" ? "retry" : "accept_failure";
          await resolveEscalation(id, disp);
          return json(res, 200, { ok: true, action: "resolve", disposition: disp });
        }
        return json(res, 400, { error: "action must be approve|reject|resolve" });
      }

      // ---------- node plane (spokes) ----------
      if (route === "POST /api/nodes/heartbeat") {
        const body = JSON.parse((await readBody(req)).toString("utf8")) as {
          id?: string;
          tags?: Record<string, unknown>;
          state?: string;
        };
        if (!body.id) return json(res, 400, { error: "id required" });
        await pool.query(
          `INSERT INTO nodes (id, tags, state, last_seen) VALUES ($1, $2, $3, now())
           ON CONFLICT (id) DO UPDATE SET tags = $2, state = $3, last_seen = now()`,
          [body.id, JSON.stringify(body.tags ?? {}), body.state ?? "idle"],
        );
        bus.publish("node", { id: body.id, state: body.state ?? "idle", tags: body.tags ?? {} });
        return json(res, 200, { ok: true });
      }

      if (route === "GET /api/work" && req.method === "GET") {
        const nodeId = url.searchParams.get("node");
        if (!nodeId) return json(res, 400, { error: "node required" });
        // heartbeat implicit in work poll
        const nodeRow = await pool.query(
          `INSERT INTO nodes (id, tags, state, last_seen) VALUES ($1, '{}', 'idle', now())
           ON CONFLICT (id) DO UPDATE SET last_seen = now() RETURNING tags`,
          [nodeId],
        );
        const tags = nodeRow.rows[0].tags as Record<string, unknown>;
        const job = await pool.query(
          `SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at LIMIT 50`,
        );
        for (const candidate of job.rows) {
          if (!nodeMatches(tags as Record<string, string | number | boolean>, candidate.requirements as Record<string, unknown>)) continue;
          const lease = new Date(Date.now() + LEASE_TTL_S * 1000);
          const claimed = await pool.query(
            `UPDATE jobs SET status = 'leased', node = $1, lease_expires = $2, updated_at = now()
             WHERE id = $3 AND status = 'queued' RETURNING *`,
            [nodeId, lease, candidate.id],
          );
          if (claimed.rowCount === 0) continue; // lost race
          await pool.query(`UPDATE nodes SET state = 'busy' WHERE id = $1`, [nodeId]);
          bus.publish("job_status", { job_id: candidate.id, status: "leased", node: nodeId });
          return json(res, 200, claimed.rows[0]);
        }
        res.writeHead(204);
        return res.end();
      }

      // ---------- job plane ----------
      const eventsMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/events$/);
      if (eventsMatch && req.method === "POST") {
        const jobId = eventsMatch[1];
        const ev = JSON.parse((await readBody(req)).toString("utf8"));
        const err = badProgressLine(ev);
        if (err) return json(res, 400, { error: `invalid progress event: ${err}` });
        const job = await pool.query(`SELECT id, status, node FROM jobs WHERE id = $1`, [jobId]);
        if (job.rowCount === 0) return json(res, 404, { error: "job not found" });
        await pool.query(
          `INSERT INTO job_events (job_id, t, pct, eta_s, stage, metrics, state)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            jobId,
            ev.t ?? null,
            ev.pct ?? null,
            ev.eta_s ?? null,
            ev.stage ?? null,
            ev.metrics ? JSON.stringify(ev.metrics) : null,
            ev.state ?? null,
          ],
        );
        // running state + lease renewal on first event from an owned job
        if (["leased", "running"].includes(job.rows[0].status)) {
          await pool.query(
            `UPDATE jobs SET status = 'running', lease_expires = now() + interval '${LEASE_TTL_S} seconds', updated_at = now() WHERE id = $1`,
            [jobId],
          );
        }
        bus.publish("job_event", { job_id: jobId, ...ev });
        const fresh = await pool.query(`SELECT cancel_requested FROM jobs WHERE id = $1`, [jobId]);
        return json(res, 200, { ok: true, cancel: fresh.rows[0]?.cancel_requested ?? false });
      }

      const statusMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/status$/);
      if (statusMatch && req.method === "POST") {
        const jobId = statusMatch[1];
        const body = JSON.parse((await readBody(req)).toString("utf8")) as {
          state?: string;
          exit_code?: number;
        };
        if (!body.state || !["running", "succeeded", "failed", "cancelled"].includes(body.state)) {
          return json(res, 400, { error: "state must be running|succeeded|failed|cancelled" });
        }
        const job = await pool.query(`SELECT id, node, status FROM jobs WHERE id = $1`, [jobId]);
        if (job.rowCount === 0) return json(res, 404, { error: "job not found" });
        await pool.query(
          `UPDATE jobs SET status = $2, exit_code = $3, lease_expires = NULL, updated_at = now() WHERE id = $1`,
          [jobId, body.state, body.exit_code ?? null],
        );
        if (["succeeded", "failed", "cancelled"].includes(body.state) && job.rows[0].node) {
          await pool.query(`UPDATE nodes SET state = 'idle' WHERE id = $1`, [job.rows[0].node]);
        }
        bus.publish("job_status", { job_id: jobId, status: body.state, exit_code: body.exit_code ?? null });
        await tick(); // immediate gate evaluation on terminal states
        return json(res, 200, { ok: true });
      }

      const resultMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/result$/);
      if (resultMatch && req.method === "POST") {
        const jobId = resultMatch[1];
        const body = JSON.parse((await readBody(req)).toString("utf8")) as {
          evidence?: Array<{ path: string; content: string }>;
          artifacts?: Array<{ path: string; content: string }>;
        };
        const job = await pool.query(`SELECT id FROM jobs WHERE id = $1`, [jobId]);
        if (job.rowCount === 0) return json(res, 404, { error: "job not found" });
        for (const kind of ["evidence", "artifacts"] as const) {
          for (const file of body[kind] ?? []) {
            await pool.query(
              `INSERT INTO artifacts (job_id, kind, path, content) VALUES ($1, $2, $3, $4)`,
              [jobId, kind === "evidence" ? "evidence" : "artifact", file.path, file.content.slice(0, 256 * 1024)],
            );
          }
        }
        bus.publish("job_result", { job_id: jobId, evidence: (body.evidence ?? []).length, artifacts: (body.artifacts ?? []).length });
        return json(res, 200, { ok: true });
      }

      const artifactsMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/artifacts$/);
      if (artifactsMatch && req.method === "GET") {
        const jobId = artifactsMatch[1];
        const rows = await pool.query(
          `SELECT kind, path, content FROM artifacts WHERE job_id = $1 ORDER BY id`,
          [jobId],
        );
        return json(res, 200, { job_id: jobId, artifacts: rows.rows });
      }

      const cancelMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
      if (cancelMatch && req.method === "POST") {
        const jobId = cancelMatch[1];
        const job = await pool.query(`SELECT id, status FROM jobs WHERE id = $1`, [jobId]);
        if (job.rowCount === 0) return json(res, 404, { error: "job not found" });
        if (job.rows[0].status === "queued") {
          await pool.query(`UPDATE jobs SET status = 'cancelled', updated_at = now() WHERE id = $1`, [jobId]);
          bus.publish("job_status", { job_id: jobId, status: "cancelled" });
        } else {
          await pool.query(`UPDATE jobs SET cancel_requested = true, updated_at = now() WHERE id = $1`, [jobId]);
          bus.publish("job_status", { job_id: jobId, status: job.rows[0].status, cancel_requested: true });
        }
        return json(res, 200, { ok: true });
      }

      if (route === "POST /api/jobs") {
        const body = JSON.parse((await readBody(req)).toString("utf8"));
        if (!body.id || !body.image || !Array.isArray(body.command)) {
          return json(res, 400, { error: "id, image, command[] required (see protocols/job.schema.json)" });
        }
        const existing = await pool.query(`SELECT id FROM jobs WHERE id = $1`, [body.id]);
        if (existing.rowCount && existing.rowCount > 0) return json(res, 409, { error: "job id exists" });
        await pool.query(
          `INSERT INTO jobs (id, plan_id, activity, image, command, requirements, outputs, timeout_s, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'queued')`,
          [
            body.id,
            body.plan_id ?? null,
            body.activity ?? null,
            body.image,
            JSON.stringify(body.command),
            JSON.stringify(body.requirements ?? {}),
            JSON.stringify(body.outputs ?? {}),
            body.timeout_s ?? 3600,
          ],
        );
        bus.publish("job_status", { job_id: body.id, status: "queued" });
        return json(res, 201, { ok: true });
      }

      // ---------- static dashboard (M6) ----------
      if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
        const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
        const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        const safe = rel.split("/").filter((p) => p && p !== "." && p !== "..").join("/");
        const file = join(publicDir, safe);
        if (!file.startsWith(publicDir) || !existsSync(file)) return json(res, 404, { error: "not found" });
        const types: Record<string, string> = {
          ".html": "text/html; charset=utf-8",
          ".js": "text/javascript; charset=utf-8",
          ".css": "text/css; charset=utf-8",
          ".svg": "image/svg+xml",
        };
        const content = readFileSync(file);
        res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream", "content-length": content.length });
        return res.end(content);
      }

      return json(res, 404, { error: `no route: ${route}` });
    } catch (e) {
      const status = e instanceof PlanError ? 400 : 500;
      return json(res, status, { error: (e as Error).message });
    }
  });
}
