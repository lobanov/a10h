/**
 * Library entry for tests: exports hub internals without starting the server
 * (src/index.ts is the runtime entrypoint).
 */
export { migrate, pool } from "./db.ts";
export { createHttpServer } from "./api.ts";
export { tick } from "./scheduler.ts";
export { parseGraph, submitPlan, approvePlan } from "./plans.ts";
export { evaluateCriteria } from "./gates.ts";
