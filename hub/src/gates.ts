/**
 * Mechanical gate-criteria evaluation (DESIGN.md §5.2, §5.3).
 *
 * Criteria are structured checks in the planning graph:
 *   - {id, check: {type: job_state, equals: succeeded}}
 *   - {id, check: {type: evidence_exists, file: metrics.json}}
 *   - {id, check: {type: evidence_json, file: metrics.json, field: final_loss, op: lt, value: 0.5}}
 *   - {id, check: {type: evidence_fields, file: metrics.json, fields: [seed, config_hash]}}
 *   - {id, check: {type: agent, note: ...}}  -> deferred to the auditor agent (always ok=true
 *     mechanically; the agent's reasonableness pass is recorded alongside)
 *
 * Evidence files are matched by path suffix (gate refers to a filename within
 * the job's declared evidence outputs).
 */
export interface CheckSpec {
  type: string;
  equals?: string;
  file?: string;
  field?: string;
  op?: string;
  value?: unknown;
  fields?: string[];
  note?: string;
}

export interface Criterion {
  id: string;
  description?: string;
  check: CheckSpec;
}

export interface CheckResult {
  id: string;
  ok: boolean;
  detail: string;
  deferred_to_agent?: boolean;
}

export interface EvidenceFile {
  path: string;
  content: string | null;
}

function findBySuffix(evidence: EvidenceFile[], file: string): EvidenceFile | undefined {
  return evidence.find((e) => e.path === file || e.path.endsWith("/" + file));
}

function compare(actual: unknown, op: string | undefined, expected: unknown): boolean {
  const a = typeof actual === "number" ? actual : Number(actual);
  const b = typeof expected === "number" ? expected : Number(expected);
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  switch (op) {
    case "lt":
      return a < b;
    case "lte":
      return a <= b;
    case "gt":
      return a > b;
    case "gte":
      return a >= b;
    case "eq":
      return a === b;
    case "ne":
      return a !== b;
    default:
      return false;
  }
}

export function evaluateCriteria(
  criteria: Criterion[],
  jobTerminalState: string | null,
  evidence: EvidenceFile[],
): { verdict: "pass" | "fail"; checks: CheckResult[] } {
  const checks: CheckResult[] = [];
  for (const c of criteria ?? []) {
    const check = c.check ?? ({} as CheckSpec);
    try {
      switch (check.type) {
        case "job_state": {
          const ok = jobTerminalState === (check.equals ?? "succeeded");
          checks.push({
            id: c.id,
            ok,
            detail: `job terminal state ${JSON.stringify(jobTerminalState)}, expected ${check.equals ?? "succeeded"}`,
          });
          break;
        }
        case "evidence_exists": {
          const f = findBySuffix(evidence, check.file ?? "");
          checks.push({
            id: c.id,
            ok: !!f && f.content !== null,
            detail: f ? `found ${f.path}` : `no evidence file matching ${check.file}`,
          });
          break;
        }
        case "evidence_json": {
          const f = findBySuffix(evidence, check.file ?? "");
          if (!f || !f.content) {
            checks.push({ id: c.id, ok: false, detail: `missing evidence file ${check.file}` });
            break;
          }
          const json = JSON.parse(f.content);
          const actual = json[check.field ?? ""];
          const ok = compare(actual, check.op, check.value);
          checks.push({
            id: c.id,
            ok,
            detail: `${check.field}=${JSON.stringify(actual)} ${check.op ?? "?"} ${JSON.stringify(check.value)} -> ${ok}`,
          });
          break;
        }
        case "evidence_fields": {
          const f = findBySuffix(evidence, check.file ?? "");
          if (!f || !f.content) {
            checks.push({ id: c.id, ok: false, detail: `missing evidence file ${check.file}` });
            break;
          }
          const json = JSON.parse(f.content);
          const missing = (check.fields ?? []).filter((k) => !(k in json));
          checks.push({
            id: c.id,
            ok: missing.length === 0,
            detail: missing.length === 0 ? `all fields present: ${(check.fields ?? []).join(", ")}` : `missing: ${missing.join(", ")}`,
          });
          break;
        }
        case "agent": {
          // Reasonableness is the auditor agent's job; mechanically neutral.
          checks.push({
            id: c.id,
            ok: true,
            deferred_to_agent: true,
            detail: check.note ?? "deferred to auditor agent",
          });
          break;
        }
        default:
          checks.push({ id: c.id, ok: false, detail: `unknown check type: ${check.type}` });
      }
    } catch (err) {
      checks.push({ id: c.id, ok: false, detail: `check error: ${(err as Error).message}` });
    }
  }
  const verdict = checks.length > 0 && checks.every((c) => c.ok) ? "pass" : "fail";
  return { verdict, checks };
}
