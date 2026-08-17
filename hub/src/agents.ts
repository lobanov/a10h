/**
 * Agent host (M5): auditor + director roles as pi SDK sessions with
 * purpose-built custom tools (record_audit / record_director_note).
 *
 * Model access: a models.json is generated from env (Z_AI_API_KEY etc.) and
 * loaded via ModelRuntime. If no provider is configured, agents are disabled
 * and every trigger is logged to agent_log — mechanical gate results still
 * stand on their own (agents augment, never block).
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pool } from "./db.ts";
import { bus } from "./bus.ts";

// The pi package: an npm dependency in the hub image; on host dev, fall back
// to the globally installed copy.
async function importPi(): Promise<any> {
  try {
    return await import("@earendil-works/pi-coding-agent");
  } catch {
    const globalPath = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
    return await import(globalPath);
  }
}

let piPromise: Promise<any> | null = null;
function pi(): Promise<any> {
  if (!piPromise) piPromise = importPi();
  return piPromise;
}

export interface AgentConfig {
  enabled: boolean;
  reason?: string;
  secretaryModel: string;
  directorModel: string;
  modelsPath: string | null;
}

let config: AgentConfig | null = null;
let runtimePromise: Promise<any> | null = null;

export function agentConfig(): AgentConfig {
  if (config) return config;
  const zaiKey = process.env.Z_AI_API_KEY ?? "";
  const localUrl = process.env.LOCAL_LLM_BASE_URL ?? "";
  const hasAny = Boolean(zaiKey || localUrl);
  const modelsPath = hasAny ? "/tmp/autoresearch-models.json" : null;
  if (hasAny && modelsPath) {
    const providers: Record<string, unknown> = {};
    if (zaiKey) {
      providers["z.ai"] = {
        api: "openai-completions",
        baseUrl: process.env.Z_AI_BASE_URL ?? "https://api.z.ai/api/coding/paas/v4",
        apiKey: zaiKey,
        models: [
          { id: "glm-5.2", name: "Z.AI GLM-5.2", contextWindow: 1000000, reasoning: true, input: ["text"] },
          { id: "glm-5.3", name: "Z.AI GLM-5.3", contextWindow: 1000000, reasoning: true, input: ["text"] },
        ],
      };
    }
    if (localUrl) {
      providers["local"] = {
        api: "openai-completions",
        baseUrl: localUrl,
        apiKey: process.env.LOCAL_LLM_API_KEY || "none",
        models: [{ id: process.env.LOCAL_LLM_MODEL ?? "default", name: "Local model", contextWindow: 131072, input: ["text"] }],
      };
    }
    mkdirSync("/tmp", { recursive: true });
    writeFileSync(modelsPath, JSON.stringify({ providers }));
  }
  config = {
    enabled: hasAny,
    reason: hasAny ? undefined : "no provider configured (set Z_AI_API_KEY or LOCAL_LLM_BASE_URL)",
    // R6: the secretary absorbed gate verification (v1 "auditor").
    secretaryModel: process.env.SECRETARY_MODEL ?? process.env.AUDITOR_MODEL ?? "local/gemma-4-26b-it",
    directorModel: process.env.DIRECTOR_MODEL ?? "z.ai/glm-5.3",
    modelsPath,
  };
  return config;
}

async function getRuntime(): Promise<any | null> {
  const cfg = agentConfig();
  if (!cfg.enabled) return null;
  if (!runtimePromise) {
    runtimePromise = (async () => {
      const mod = await pi();
      return await mod.ModelRuntime.create({ modelsPath: cfg.modelsPath });
    })();
  }
  try {
    return await runtimePromise;
  } catch (e) {
    await logAgent("system", "runtime_error", { error: String(e) });
    return null;
  }
}

async function resolveModel(runtime: any, providerSlashModel: string): Promise<any | null> {
  const [provider, ...rest] = providerSlashModel.split("/");
  const model = rest.join("/");
  const m = runtime.getModel(provider, model);
  if (!m) {
    await logAgent("system", "model_not_found", { model: providerSlashModel });
    return null;
  }
  return m;
}

async function logAgent(role: string, event: string, data: unknown): Promise<void> {
  try {
    await pool.query(`INSERT INTO agent_log (role, event, data) VALUES ($1, $2, $3)`, [
      role,
      event,
      JSON.stringify(data),
    ]);
    bus.publish("agent", { role, event, data });
  } catch {
    // logging must never crash the hub
  }
}

/** Run one agent turn: model must call `toolName` exactly once with a JSON payload. */
/** Serialize turns per role: avoids provider rate limits from parallel calls. */
const roleQueues = new Map<string, Promise<unknown>>();
function enqueue<T>(role: string, task: () => Promise<T>): Promise<T> {
  const prev = roleQueues.get(role) ?? Promise.resolve();
  const next = prev.then(task, task);
  roleQueues.set(role, next.catch(() => undefined));
  return next;
}

async function runAgentTurn(opts: {
  role: "secretary" | "director";
  model: string;
  systemPrompt: string;
  userPrompt: string;
  toolName: string;
  toolDescription: string;
  timeoutMs: number;
}): Promise<Record<string, unknown> | null> {
  const runtime = await getRuntime();
  if (!runtime) {
    await logAgent(opts.role, "skipped_disabled", { reason: agentConfig().reason });
    return null;
  }
  const model = await resolveModel(runtime, opts.model);
  if (!model) return null;

  const mod = await pi();
  let captured: Record<string, unknown> | null = null;

  const tool = mod.defineTool({
    name: opts.toolName,
    label: opts.toolName,
    description: opts.toolDescription,
    parameters: {
      type: "object",
      properties: {
        verdict: { type: "string", description: "concise verdict/summary line" },
        note: { type: "string", description: "reasoning, evidence-referenced, 3-10 sentences" },
      },
      required: ["verdict", "note"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      captured = params;
      return { content: [{ type: "text", text: "recorded" }], details: {} };
    },
  });

  const { session } = await mod.createAgentSession({
    model,
    modelRuntime: runtime,
    sessionManager: mod.SessionManager.inMemory(),
    noTools: "builtin", // disable built-ins; keep customTools (tools:[] would exclude them)
    customTools: [tool],
  });

  try {
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("agent timeout")), opts.timeoutMs));
    await Promise.race([session.prompt(`${opts.systemPrompt}\n\n${opts.userPrompt}`), timeout]);
  } catch (e) {
    await logAgent(opts.role, "turn_error", { error: String(e) });
    session.dispose();
    return null;
  }
  session.dispose();
  if (!captured) {
    await logAgent(opts.role, "no_tool_call", { tool: opts.toolName });
    return null;
  }
  return captured;
}

/**
 * Secretary — gate verification (R6): a FORMAL submission check over a
 * completed gate evaluation. Criteria met, claims evidenced and reasonable.
 * This is NOT adversarial research review (that is commissioned as ordinary
 * tasks, never a secretary duty) and NEVER evaluates research direction.
 */
export async function queueVerification(input: {
  gateResultId: number;
  plan_id: string;
  activity: string;
  job_id: string;
  verdict: "pass" | "fail";
  checks: Array<{ id: string; ok: boolean; detail: string }>;
  evidence: Array<{ path: string; content: string | null }>;
}): Promise<void> {
  const cfg = agentConfig();
  const evidenceText = input.evidence
    .map((e) => `--- ${e.path} ---\n${(e.content ?? "").slice(0, 2000)}`)
    .join("\n");
  const checksText = input.checks.map((c) => `- ${c.id}: ${c.ok ? "PASS" : "FAIL"} (${c.detail})`).join("\n");
  const result = await enqueue("secretary", () =>
    runAgentTurn({
      role: "secretary",
      model: cfg.secretaryModel,
    systemPrompt:
      "You are the research lab's secretary agent performing FORMAL gate verification: check that submission criteria are met and claims are evidenced and reasonable. " +
      "You must call the tool record_audit exactly once with {verdict, note}. " +
      "verdict is one of: agree_pass, agree_fail, dispute. " +
      "note references the evidence: say what supports or undermines the claims. Be skeptical of suspiciously smooth numbers, missing seeds, or claims the evidence does not support. " +
      "You do NOT perform adversarial research review and you never judge research direction — formal submission criteria only.",
    userPrompt:
      `Gate result for activity "${input.activity}" (plan ${input.plan_id}, job ${input.job_id}).\n` +
      `Mechanical verdict: ${input.verdict}\nMechanical checks:\n${checksText}\n\nEvidence files:\n${evidenceText || "(none)"}\n\n` +
      `Call record_audit with your independent judgment.`,
      toolName: "record_audit",
      toolDescription: "Record the secretary's verification verdict and evidence-referenced note.",
      timeoutMs: 180_000,
    }),
  );
  if (result) {
    await pool.query(`UPDATE gate_results SET audit_note = $1 WHERE id = $2`, [
      JSON.stringify(result),
      input.gateResultId,
    ]);
    await logAgent("secretary", "verification_recorded", {
      gate_result_id: input.gateResultId,
      activity: input.activity,
      verdict: result.verdict,
    });
  }
}

/** Director: recommendation attached to escalations. */
export async function queueDirector(input: {
  approvalId: number;
  plan_id: string;
  activity: string;
  attempt: number;
  reason: string;
  failed_checks: Array<{ id: string; ok: boolean; detail: string }>;
}): Promise<void> {
  const cfg = agentConfig();
  const checksText = input.failed_checks.map((c) => `- ${c.id}: ${c.detail}`).join("\n");
  const result = await enqueue("director", () =>
    runAgentTurn({
      role: "director",
      model: cfg.directorModel,
    systemPrompt:
      "You are the research lab's director agent. A worker activity has failed its gate twice and escalated. " +
      "You must call the tool record_director_note exactly once with {verdict, note}. " +
      "verdict is one of: accept_failure, retry, revise_plan, escalate_human. " +
      "note gives your rationale grounded in the failed checks and the goal of honest, evidence-based research.",
    userPrompt:
      `Escalation for activity "${input.activity}" (plan ${input.plan_id}, attempt ${input.attempt}).\n` +
      `Reason: ${input.reason}\nFailed checks:\n${checksText}\n\n` +
      `Recommend a disposition for the human operator. Call record_director_note.`,
      toolName: "record_director_note",
      toolDescription: "Record the director's recommendation for an escalated activity.",
      timeoutMs: 180_000,
    }),
  );
  if (result) {
    await pool.query(`UPDATE approvals SET agent_note = $1 WHERE id = $2`, [JSON.stringify(result), input.approvalId]);
    await logAgent("director", "recommendation_recorded", {
      approval_id: input.approvalId,
      activity: input.activity,
      verdict: result.verdict,
    });
  }
}
