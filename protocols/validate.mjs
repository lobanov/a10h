#!/usr/bin/env node
/**
 * Protocol validator: check a run directory against the v0 schemas.
 *
 *   node protocols/validate.mjs <run-dir> [<run-dir> ...]
 *
 * Validates every progress.jsonl line against progress.schema.json and, if a
 * metrics.json is present, checks it has the evidence fields gates rely on
 * (variant/seed/final_loss are demo conventions; the required-generic set is
 * seed + config_hash + final metrics). Exit 1 on any violation.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Minimal JSON Schema checker: supports the subset used by our schemas
// (type, required, enum, minimum, maximum, minLength, minItems, pattern,
// properties, additionalProperties, items).
function validate(instance, schema, path, errors) {
  if (schema.type) {
    const t = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = Array.isArray(instance) ? "array" : typeof instance;
    if (!t.includes(actual)) {
      errors.push(`${path}: expected type ${t.join("|")}, got ${actual}`);
      return;
    }
  }
  if (schema.enum && !schema.enum.includes(instance)) {
    errors.push(`${path}: ${JSON.stringify(instance)} not in [${schema.enum.join(", ")}]`);
  }
  if (typeof instance === "number") {
    if (schema.minimum !== undefined && instance < schema.minimum)
      errors.push(`${path}: ${instance} < minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && instance > schema.maximum)
      errors.push(`${path}: ${instance} > maximum ${schema.maximum}`);
  }
  if (typeof instance === "string") {
    if (schema.minLength !== undefined && instance.length < schema.minLength)
      errors.push(`${path}: shorter than minLength ${schema.minLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(instance))
      errors.push(`${path}: does not match ${schema.pattern}`);
  }
  if (Array.isArray(instance)) {
    if (schema.minItems !== undefined && instance.length < schema.minItems)
      errors.push(`${path}: fewer than minItems ${schema.minItems}`);
    if (schema.items) instance.forEach((v, i) => validate(v, schema.items, `${path}[${i}]`, errors));
  }
  if (instance && typeof instance === "object" && !Array.isArray(instance)) {
    for (const key of schema.required || []) {
      if (!(key in instance)) errors.push(`${path}: missing required "${key}"`);
    }
    if (schema.properties) {
      for (const [k, sub] of Object.entries(schema.properties)) {
        if (k in instance) validate(instance[k], sub, `${path}.${k}`, errors);
      }
      if (schema.additionalProperties === false) {
        for (const k of Object.keys(instance)) {
          if (!(k in schema.properties)) errors.push(`${path}: unexpected property "${k}"`);
        }
      }
    }
  }
}

const progressSchema = JSON.parse(readFileSync(new URL("./progress.schema.json", import.meta.url)));
const jobSchema = JSON.parse(readFileSync(new URL("./job.schema.json", import.meta.url)));

function validateRun(dir) {
  let ok = true;
  const p = join(dir, "progress.jsonl");
  if (!existsSync(p)) {
    console.log(`FAIL ${dir}: no progress.jsonl`);
    return false;
  }
  const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
  let terminal = null;
  const errors = [];
  lines.forEach((line, i) => {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      errors.push(`line ${i + 1}: invalid JSON`);
      return;
    }
    validate(ev, progressSchema, `line ${i + 1}`, errors);
    if (ev.state) terminal = ev.state;
  });
  if (!terminal) errors.push("no terminal line (state: succeeded|failed)");
  const m = join(dir, "metrics.json");
  if (existsSync(m)) {
    try {
      const metrics = JSON.parse(readFileSync(m, "utf8"));
      for (const f of ["seed", "config_hash", "final_loss"]) {
        if (!(f in metrics)) errors.push(`metrics.json: missing evidence field "${f}"`);
      }
    } catch {
      errors.push("metrics.json: invalid JSON");
    }
  }
  if (errors.length) {
    ok = false;
    console.log(`FAIL ${dir}`);
    for (const e of errors) console.log(`  - ${e}`);
  } else {
    console.log(`PASS ${dir} (${lines.length} events, terminal=${terminal})`);
  }
  return ok;
}

function validateJobSpec(file) {
  const errors = [];
  try {
    validate(JSON.parse(readFileSync(file, "utf8")), jobSchema, "job", errors);
  } catch (e) {
    errors.push(String(e.message));
  }
  if (errors.length) {
    console.log(`FAIL ${file}`);
    errors.forEach((e) => console.log(`  - ${e}`));
    return false;
  }
  console.log(`PASS ${file}`);
  return true;
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("usage: node validate.mjs <run-dir|job.json> [...]");
  process.exit(2);
}
let allOk = true;
for (const a of args) {
  if (a.endsWith(".json") && !existsSync(join(a, "progress.jsonl"))) allOk = validateJobSpec(a) && allOk;
  else if (existsSync(a) && readdirSync(a) !== undefined) allOk = validateRun(a) && allOk;
  else {
    console.log(`FAIL ${a}: not found`);
    allOk = false;
  }
}
process.exit(allOk ? 0 : 1);
