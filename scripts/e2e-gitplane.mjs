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

const ROOT = join(import.meta.dirname, "..");
const CA = join(ROOT, "data/git/ca/ca.crt");
const REPOS = join(ROOT, "data/repos");
const HUB = process.env.HUB_URL ?? "https://localhost:8080";

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

  const taskPush = compose("worker-a",
    `cd /tmp/demo && git push origin HEAD:refs/tasks/r1-smoke 2>&1; echo EXIT=$?`);
  ok("push to refs/tasks/* accepted", /EXIT=0/.test(taskPush) && !/Everything up-to-date/.test(taskPush), taskPush.trim().split("\n").pop());

  const refs = sh("git", ["--git-dir", join(REPOS, "demo.git"), "for-each-ref"]).trim();
  ok("task ref exists in bare repo", refs.includes("refs/tasks/r1-smoke"));
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
    sh("git", ["clone", "-q", "--bare", join(REPOS, "demo.git"), join(tmp, "wt.git")]);
    sh("git", ["--git-dir", join(tmp, "wt.git"), "config", "user.name", "r1"]);
    sh("git", ["--git-dir", join(tmp, "wt.git"), "config", "user.email", "r1@local"]);
    // Commit directly on the bare fixture working tree (worktree-less trick:
    // use a temporary index against the checked-out tree).
    sh("bash", ["-c",
      `cd '${tmp}' && git --git-dir=wt.git --work-tree=. checkout -q main ` +
      `&& echo 'operator edit' >> goal.md ` +
      `&& git --git-dir=wt.git --work-tree=. add -A ` +
      `&& git --git-dir=wt.git --work-tree=. commit -q -m 'chore: operator edit from upstream fixture'`]);
    const fixture = join(REPOS, "upstream-fixture.git");
    if (existsSync(fixture)) rmSync(fixture, { recursive: true, force: true });
    sh("bash", ["-c", `cd '${tmp}' && git clone -q --bare wt.git '${fixture}'`]);
    sh("git", ["--git-dir", fixture, "symbolic-ref", "HEAD", "refs/heads/main"]);

    // Wire upstream inside the hub container (same /data/repos volume).
    compose("hub",
      `git --git-dir=/data/repos/demo.git remote remove upstream 2>/dev/null; ` +
      `git --git-dir=/data/repos/demo.git remote add upstream /data/repos/upstream-fixture.git`);

    const sync = JSON.parse(sh("curl", [
      "-s", "--cacert", CA, "-X", "POST", "-H", "content-type: application/json",
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

console.log(`\nR1 git-plane: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
