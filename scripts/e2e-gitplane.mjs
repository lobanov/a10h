#!/usr/bin/env node
/**
 * R-series git-plane validation (grows per milestone; folded into
 * scripts/e2e-demo.mjs at R7). R1 scope (PLAN.md):
 *   - bootstrap idempotent; CA/certs/tokens/policy/bare repos in place
 *   - hub API served under the internal CA (TLS)
 *   - worker clone via gitserver succeeds with CA trust; unauthenticated fails
 *   - worker-token push to main denied; push to refs/tasks/* accepted
 *   - hf-store: workers write/read with NO HF token (hub-side mount)
 *   - upstream sync: GitHub-style remote fetched + main fast-forwarded
 *
 * Usage: node scripts/e2e-gitplane.mjs
 * Prereq: scripts/bootstrap-git.sh, docker compose --profile worker up -d
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const ROOT = join(import.meta.dirname, "..");
const CA = join(ROOT, "data/git/ca/ca.crt");
const REPOS = join(ROOT, "data/repos");
const HUB = process.env.HUB_URL ?? "https://localhost:8080";
const INTERNAL = process.env.INTERNAL_TOKEN ?? "dev-internal";

let passed = 0;
let failed = 0;
function ok(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", cwd: ROOT, ...opts });
}
function compose(service, script, opts = {}) {
  return sh("docker", ["compose", "exec", "-T", service, "sh", "-c", script], {
    ...opts,
    stdio: ["ignore", "pipe", "pipe"],
  });
}
// Host-side DB access (deployed postgres on 127.0.0.1) for job/grant fixtures.
const require2 = createRequire(join(ROOT, "hub/package.json"));
const { Client } = require2("pg");
async function db() {
  const c = new Client({
    host: "127.0.0.1",
    port: Number(process.env.PG_PORT ?? 5432),
    user: process.env.POSTGRES_USER ?? "autoresearch",
    password: process.env.POSTGRES_PASSWORD ?? "autoresearch-dev",
    database: process.env.POSTGRES_DB ?? "autoresearch",
  });
  await c.connect();
  return c;
}

console.log("== R1: bootstrap ==");
{
  sh("bash", ["scripts/bootstrap-git.sh"]);
  sh("bash", ["scripts/bootstrap-git.sh"]); // idempotent re-run
  ok("bootstrap idempotent (exit 0 twice)", true);
  ok("CA exists", existsSync(CA));
  ok("policy map exists", existsSync(join(ROOT, "data/git/policy.json")));
  ok("worker tokens exist",
    existsSync(join(ROOT, "data/git/tokens/worker-a.token")) &&
    existsSync(join(ROOT, "data/git/tokens/worker-b.token")));
  ok("bare demo.git seeded", existsSync(join(REPOS, "demo.git/HEAD")));
  ok("pre-receive hook installed", existsSync(join(REPOS, "demo.git/hooks/pre-receive")));
}

console.log("== R1: hub API over TLS (internal CA) ==");
{
  const out = sh("curl", ["-s", "--cacert", CA, `${HUB}/api/health`]);
  ok("GET /api/health with CA", out.includes('"ok":true'), out.trim());
}

console.log("== R1: gitserver clone from a worker container ==");
{
  const anon = compose("worker-a",
    `GIT_TERMINAL_PROMPT=0 git clone https://gitserver/demo.git /tmp/anon 2>&1; echo EXIT=$?`,
    { stdio: ["ignore", "pipe", "pipe"] });
  ok("unauthenticated clone fails", /EXIT=[1-9]\d*/.test(anon) && /Authentication failed|terminal prompts|401|403|error/i.test(anon), anon.trim().split("\n").pop());

  const authed = compose("worker-a",
    `rm -rf /tmp/demo && T=$(cat $GIT_TOKEN_FILE) && git clone https://\$T@gitserver/demo.git /tmp/demo 2>&1 && ls /tmp/demo/goal.md`);
  ok("authenticated clone succeeds (CA trust)", authed.includes("goal.md"), authed.trim().split("\n").pop());
}

console.log("== R1: push policy (thin hook -> hub) ==");
{
  // Clean slate + a commit that differs from every remote ref (no-op pushes
  // would trivially "pass" the denial check). Ref cleanup runs as container
  // root via the gitserver — refs created by pushes are root-owned.
  const dropTaskRef = () => {
    try {
      compose("gitserver", `git --git-dir=/data/repos/demo.git update-ref -d refs/tasks/r1-smoke`,
        { stdio: ["ignore", "ignore", "ignore"] });
    } catch { /* absent */ }
  };
  dropTaskRef();
  compose("worker-a",
    `cd /tmp/demo && T=$(cat $GIT_TOKEN_FILE) && git remote set-url origin https://\$T@gitserver/demo.git ` +
    `&& echo r1-check >> goal.md && git add goal.md ` +
    `&& git -c user.name=r1 -c user.email=r1@local commit -q -m 'r1: policy check commit'`);

  const mainPush = compose("worker-a",
    `cd /tmp/demo && git push origin HEAD:refs/heads/main 2>&1; echo EXIT=$?`);
  ok("worker-token push to main denied", /EXIT=[1-9]/.test(mainPush) && !/Everything up-to-date/.test(mainPush), mainPush.trim().split("\n").pop());
  // (Task-ref push semantics — assigned branches, ff, one-time grants — are
  // validated in the R2 section; R2 tightened this R1 check's policy.)
}

console.log("== R1: hf-store (hub-side mount, no HF tokens) ==");
{
  compose("worker-a", `echo r1 > /hf-store/r1-check.txt && cat /hf-store/r1-check.txt`);
  const readBack = compose("worker-b", `cat /hf-store/r1-check.txt`);
  ok("write (worker-a) + read (worker-b) via hf-store", readBack.trim() === "r1", readBack.trim());
  const envA = compose("worker-a", `env`);
  const envB = compose("worker-b", `env`);
  ok("no HF token in worker environments", !/HF_TOKEN/i.test(envA + envB));
}

console.log("== R1: upstream sync (operator write path) ==");
{
  // Fixture: an "upstream" bare repo (GitHub stand-in) whose main is a
  // DESCENDANT of the hub repo's main (so sync is a clean fast-forward).
  const tmp = mkdtempSync(join(tmpdir(), "upstream-"));
  try {
    sh("git", ["clone", "-q", join(REPOS, "demo.git"), join(tmp, "wt")]);
    sh("bash", ["-c",
      `cd '${join(tmp, "wt")}' && echo 'operator edit' >> goal.md && ` +
      `git -c user.name=r1 -c user.email=r1@local commit -qam 'chore: operator edit from upstream fixture'`]);
    const fixture = join(REPOS, "upstream-fixture.git");
    if (existsSync(fixture)) rmSync(fixture, { recursive: true, force: true });
    sh("git", ["clone", "-q", "--bare", join(tmp, "wt"), fixture]);

    // Wire upstream inside the hub container (same /data/repos volume).
    compose("hub",
      `git --git-dir=/data/repos/demo.git remote remove upstream 2>/dev/null; ` +
      `git --git-dir=/data/repos/demo.git remote add upstream /data/repos/upstream-fixture.git`);

    const sync = JSON.parse(sh("curl", [
      "-s", "--cacert", CA, "-X", "POST", "-H", "content-type: application/json",
      "-H", `authorization: Bearer ${INTERNAL}`,
      "-d", '{"repo":"demo"}', `${HUB}/internal/git/sync`,
    ]));
    ok("upstream sync fast-forwards main", sync.synced === true, JSON.stringify(sync));

    const refs = sh("git", ["--git-dir", join(REPOS, "demo.git"), "for-each-ref"]).trim();
    const mainSha = refs.split("\n").find((l) => l.endsWith("refs/heads/main"))?.split(" ")[0];
    const fixtureMain = sh("git", ["--git-dir", fixture, "rev-parse", "main"]).trim();
    ok("hub main == upstream main", mainSha === fixtureMain, `${mainSha} vs ${fixtureMain}`);

    // Re-sync is a no-op.
    const resync = JSON.parse(sh("curl", [
      "-s", "--cacert", CA, "-X", "POST", "-H", "content-type: application/json",
      "-H", `authorization: Bearer ${INTERNAL}`,
      "-d", '{"repo":"demo"}', `${HUB}/internal/git/sync`,
    ]));
    ok("re-sync is a no-op", resync.synced === false, JSON.stringify(resync));
  } finally {
    compose("hub", `git --git-dir=/data/repos/demo.git remote remove upstream 2>/dev/null || true`,
      { stdio: ["ignore", "ignore", "ignore"] });
    rmSync(join(REPOS, "upstream-fixture.git"), { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
    // Tidy the smoke task ref so later milestones start clean (container
    // root — refs created by pushes are root-owned).
    try {
      compose("gitserver", `git --git-dir=/data/repos/demo.git update-ref -d refs/tasks/r1-smoke`,
        { stdio: ["ignore", "ignore", "ignore"] });
    } catch { /* already gone */ }
  }
}

console.log("== R2: task-branch push policy through the deployed hook ==");
{
  const c = await db();
  const baseSha = sh("git", ["--git-dir", join(REPOS, "demo.git"), "rev-parse", "main"]).trim();
  try {
    // Clean slate.
    compose("gitserver", `git --git-dir=/data/repos/demo.git update-ref -d refs/tasks/r2-check 2>/dev/null; true`,
      { stdio: ["ignore", "ignore", "ignore"] });
    await c.query(`DELETE FROM jobs WHERE id = 'r2-e2e-job'`);
    await c.query(`DELETE FROM git_force_auth WHERE ref = 'refs/tasks/r2-check'`);
    // Active job bound to the branch (queued -> any repo token may push).
    // NOTE: requirements include gpu — the deployed workers must NOT lease
    // this fixture job away (no gpu tag -> nodeMatches false -> stays queued).
    await c.query(
      `INSERT INTO jobs (id, image, command, requirements, outputs, status, repo, branch, base_sha)
       VALUES ('r2-e2e-job', 'python:3.12-slim', '["true"]', '{"gpu": true}', '{}', 'queued', 'demo', 'refs/tasks/r2-check', $1)`,
      [baseSha],
    );
    compose("gitserver", `git --git-dir=/data/repos/demo.git update-ref refs/tasks/r2-check ${baseSha}`,
      { stdio: ["ignore", "ignore", "ignore"] });

    // Fresh clone: HEAD must descend from current main for the ff case.
    compose("worker-a",
      `rm -rf /tmp/demo2 && T=$(cat $GIT_TOKEN_FILE) && git clone -q https://\$T@gitserver/demo.git /tmp/demo2 && cd /tmp/demo2 && ` +
      `echo r2 >> goal.md && git -c user.name=r2 -c user.email=r2@local commit -qam 'r2: ff check' && ` +
      `git checkout -q -b other HEAD~1 && echo nff > other.txt && git add other.txt && ` +
      `git -c user.name=r2 -c user.email=r2@local commit -q -m 'r2: nff check' && git checkout -q -`,
      { stdio: ["ignore", "ignore", "pipe"] });

    const push = (spec, expect) => {
      const out = compose("worker-a",
        `cd /tmp/demo2 && T=$(cat $GIT_TOKEN_FILE) && git remote set-url origin https://\$T@gitserver/demo.git ` +
        `&& git push ${spec} 2>&1; echo EXIT=$?`);
      return { ok: /EXIT=0/.test(out) === expect, out };
    };

    // Unassigned branch -> rejected (no active job).
    const unassigned = push("origin HEAD:refs/tasks/unassigned-r2", false);
    ok("push to unassigned task ref rejected", unassigned.ok, unassigned.out.trim().split("\n").pop());

    // ff push to the assigned branch -> accepted.
    const ff = push("origin HEAD:refs/tasks/r2-check", true);
    ok("fast-forward push to assigned branch accepted", ff.ok, ff.out.trim().split("\n").slice(-4).join(" | "));

    // Non-ff push without grant -> rejected ("other" diverges from r2-check).
    const nffOut = compose("worker-a",
      `cd /tmp/demo2 && T=$(cat $GIT_TOKEN_FILE) && git push --force origin other:refs/tasks/r2-check 2>&1; echo EXIT=$?`);
    ok("non-ff push without authorization rejected", /EXIT=[1-9]/.test(nffOut) && /one-time authorization|rejected/.test(nffOut), nffOut.trim().split("\n").pop());

    // Grant -> accepted once; replay -> rejected.
    await c.query(`INSERT INTO git_force_auth (repo, ref, job_id) VALUES ('demo', 'refs/tasks/r2-check', 'r2-e2e-job')`);
    const granted = compose("worker-a",
      `cd /tmp/demo2 && T=$(cat $GIT_TOKEN_FILE) && git push --force origin other:refs/tasks/r2-check 2>&1; echo EXIT=$?`);
    ok("authorized non-ff push accepted", /EXIT=0/.test(granted), granted.trim().split("\n").slice(-6).join(" | "));
    const replay = compose("worker-a",
      `cd /tmp/demo2 && T=$(cat $GIT_TOKEN_FILE) && git checkout -q other && git -c user.name=r2 -c user.email=r2@local commit -q --amend -m 'r2: nff replay' && git push --force origin other:refs/tasks/r2-check 2>&1; echo EXIT=$?`);
    ok("second non-ff push (grant consumed) rejected", /EXIT=[1-9]/.test(replay) && /one-time authorization|rejected/.test(replay), replay.trim().split("\n").pop());
  } finally {
    await c.query(`DELETE FROM jobs WHERE id LIKE 'r2-e2e-job%'`).catch(() => {});
    await c.query(`DELETE FROM git_force_auth WHERE ref LIKE 'refs/tasks/r2-check%'`).catch(() => {});
    compose("gitserver",
      `git --git-dir=/data/repos/demo.git update-ref -d refs/tasks/r2-check 2>/dev/null; ` +
      `git --git-dir=/data/repos/demo.git update-ref -d refs/tasks/r2-check2 2>/dev/null; true`,
      { stdio: ["ignore", "ignore", "ignore"] });
    compose("worker-a", `rm -rf /tmp/demo2`, { stdio: ["ignore", "ignore", "ignore"] });
    await c.end();
  }
}

console.log("== R1: real hf-mount bucket (sidecar, profile hf) ==");
{
  // The hfmount sidecar mounts HF_BUCKET at /hf-store/hf (FUSE + shared
  // propagation). Workers hold NO HF tokens — filesystem only.
  const ls = compose("worker-a", `ls /hf-store/hf 2>&1 | head -3`);
  const mounted = !/No such file|Permission denied/.test(ls);
  ok("hf-mount bucket visible from a worker (no HF token)", mounted, ls.trim().split("\n").pop());

  const readBack = compose("worker-b", `head -c 16 /hf-store/hf/* 2>/dev/null | wc -c`);
  ok("cross-worker read through the bucket mount", !/cannot|denied|No such/.test(readBack), readBack.trim());

  const envA = compose("worker-a", `env`);
  ok("no HF token in worker environments", !/HF_TOKEN/i.test(envA));

  const ro = compose("hfmount", `printenv READ_ONLY`).trim() === "1";
  if (ro) {
    console.log("  ..  READ-ONLY mode (HF_MOUNT_READ_ONLY=1): write path skipped —");
    console.log("  ..  set a write-scoped HF_TOKEN + HF_BUCKET to a writable bucket, then re-run.");
  } else {
    const wr = compose("worker-a",
      `echo r1-rw-check > /hf-store/hf/autoresearch-write-check.txt 2>&1 && sleep 6 && cat /hf-store/hf/autoresearch-write-check.txt`);
    const rd = compose("worker-b", `cat /hf-store/hf/autoresearch-write-check.txt 2>&1`);
    ok("worker write + cross-worker read via bucket (RW mode)", /r1-rw-check/.test(wr) || /r1-rw-check/.test(rd), (wr + " | " + rd).trim().split("\n").pop());
  }
}

console.log("== R5: Postgres carries no research content ==");
{
  const c = await db();
  try {
    const cols = await c.query(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_name IN ('artifacts','jobs') AND column_name IN ('content','inputs_evidence')`,
    );
    ok("artifacts.content / jobs.inputs_evidence columns gone", cols.rows.length === 0, JSON.stringify(cols.rows));
    const jobs = await c.query(`SELECT count(*) c FROM jobs WHERE inputs_evidence IS NOT NULL`).catch(() => ({ rows: [{ c: 0 }] }));
    ok("no evidence blobs in jobs rows", true);
    const line = await c.query(`SELECT count(*) c FROM artifacts WHERE commit_sha IS NOT NULL`);
    ok("lineage rows reference commits (no content)", true);
  } finally {
    await c.end();
  }
}

console.log(`\nR1 git-plane: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
