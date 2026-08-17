---
name: design-review
description: Streamline a headless external design/plan review — spawn a read-only Pi CLI session on a stronger model (default glm-5.3 via z.ai) to review DESIGN.md/PLAN.md or other docs for implementation risks, unclear requirements, inconsistencies, and missing pieces; then triage (verify claims, action minor clarifications, escalate majors with recommendations). Use when asked to review/refactor design docs, get a second opinion, or pre-implementation readiness check.
license: MIT
compatibility: Requires pi CLI on PATH with a configured provider in ~/.pi/agent/models.json (z.ai → glm-5.3 by default); node for JSON parsing.
---

# Design review — headless second opinion

Two stages: **(1) run** a read-only reviewer session headlessly, **(2) triage** its findings. Never let the reviewer mutate the repo; you (the main session) verify and act.

## 1. Healthcheck (cheap, always first)

```bash
pi -p --provider "z.ai" --model glm-5.3 --no-session -nc -ns -ne -np -t read \
  "Reply with exactly: HEALTHCHECK-OK"
```

If this doesn't print `HEALTHCHECK-OK`, fix provider/model/auth before the long run (see references/incidents.md).

## 2. Run the review

Use **JSON mode with output redirected to a file** (text mode has failed silently on long prompts — see incidents). Flags: `--no-session` (ephemeral), `-nc -ns -ne -np` (no context files/skills/extensions/templates — keep the reviewer free of project conditioning), `-t read` (read-only tool allowlist).

```bash
cd <repo>
pi -p --provider "z.ai" --model glm-5.3 --no-session -nc -ns -ne -np -t read \
  --mode json --name "design-plan-review" \
  "<REVIEW PROMPT — template below>" > /tmp/pi-review.json 2>/tmp/pi-review.err
echo "EXIT=$?"; wc -c /tmp/pi-review.json   # must be non-trivial (MBs); err must be 0
```

### Review prompt template

```
You are a senior systems engineer doing an implementation-readiness review of
<one-line system description>.

Read these files fully:
- <doc1> (what it is)
- <doc2> (…)
- <supporting files for cross-reference>

Your task: identify
(1) RISKS — design decisions or omissions hard to implement correctly or that
    will bite during <upcoming work>;
(2) UNCLEAR/AMBIGUOUS requirements — places an implementer must guess
    (undefined terms, missing schemas/state machines, unowned responsibilities);
(3) INCONSISTENCIES between docs or within a doc;
(4) anything MAJOR missing entirely.

Be concrete and skeptical: challenge <the specific mechanisms under review,
e.g. "the pre-receive hook, task branches, rebase+re-verify, SSE sessions">.
Do NOT praise the design.

Output format (markdown, no preamble):
## Major (blocks or reorders implementation)
- **[M#] title** — location — what is wrong/missing — why it bites — suggested resolution
## Minor (clarification or local fix)
- **[m#] title** — location — issue — suggested clarification
## Notes (observations, no action needed)
- ...
Keep each finding under 4 lines. If a concern is actually addressed elsewhere
in the docs, verify by reading that section before reporting it.
```

The numbered IDs and the "verify elsewhere before reporting" clause measurably improve precision; keep them.

### Extract the final report

```bash
node -e "
const fs=require('fs');
const lines=fs.readFileSync('/tmp/pi-review.json','utf8').trim().split('\n')
  .map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);
let last=null;
for(const e of lines){const m=e.message||e;
  if((e.type==='assistant'||m.role==='assistant')&&m.content){
    const t=(Array.isArray(m.content)?m.content:[]).filter(c=>c.type==='text'||typeof c==='string')
      .map(c=>typeof c==='string'?c:c.text).join('');
    if(t.trim())last=t;}}
fs.writeFileSync('/tmp/pi-review.md',last||'NONE');
console.log('length:',last?last.length:0);"
```

Keep the raw report (`/tmp/pi-review.md`) — quote it in commit messages and to the operator.

## 3. Triage

1. **Verify before acting.** For each factual claim (file says X, field Y missing), `grep`/`read` the file. Reviewers misread diagrams and invent fields; ~1 in 5 findings typically dissolves on verification.
2. **Action minors now** — clarifications and local fixes that follow naturally from existing decisions: fold into the docs with a coherent commit ("clarifications from external review").
3. **Escalate majors** — decision items (contradictions between accepted decisions, missing mechanisms, ownership gaps): present each to the operator *with a recommendation*, numbered, and wait for input. Never resolve an architectural trade-off unilaterally.
4. **Record decisions.** When the operator answers, fold decisions into design docs + plan (milestones/acceptance), truth-align every cross-reference (grep old terms repo-wide), and commit per decision batch.

### Triage rubric

| Finding kind | Action |
|---|---|
| Doc inconsistency/ambiguity with an obvious resolution | Fix now, list in commit |
| Contradicts an explicit operator decision | Fix toward the decision |
| Undesigned mechanism that R-series assumes | Add to open questions + owning milestone task |
| Architectural trade-off / missing capability | Escalate with recommendation |

## Tuning

- Default reviewer: `glm-5.3` (strong, cheap, follows the format). Override with `--provider/--model` for a second pass on the same docs (fresh `--no-session` each time; cross-model disagreement is signal).
- Review the normative/protocol docs together with DESIGN/PLAN — drift there is where rebuild-the-wrong-thing risk hides.
- For large repos, list exact files in the prompt (as above) rather than letting the reviewer explore; it reads fewer tangents and finishes faster.
