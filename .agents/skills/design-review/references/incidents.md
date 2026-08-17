# Design-review incidents — what went wrong and the fix

## 1. Text mode silently produced no output (long prompt)

**When:** first headless review run (glm-5.3, ~1k-token prompt, `-p` text mode,
`2>&1 | tail -120`).

**Symptom:** EXIT=0, zero bytes of stdout. A minimal "HEALTHCHECK-OK" prompt
in the same configuration worked fine.

**Cause (working theory):** long multi-turn tool-using sessions + text mode +
pipe; the final assistant text never reached stdout even though the session
ran (later JSON capture showed a 2.3 MB event stream with a complete final
report).

**Fix (now the standard procedure):**
1. Always healthcheck the exact provider/model first.
2. Run with `--mode json` and redirect to a file (`> /tmp/pi-review.json`).
3. Assert the file is non-trivial and stderr is empty *before* parsing.
4. Extract the last assistant text from the JSONL stream (node one-liner in
   SKILL.md §2).

**Do not** retry text mode "one more time" — it wastes a full model run.

## 2. Reviewer findings need factual verification

**When:** triaging the first review (11 major / 12 minor findings).

**Symptom:** most findings were real, but precision was ~80%, not 100%. One
finding cited a "variant flag mismatch" that *was* real; others
misremembered diagram details or flagged things actually addressed two
sections later.

**Fix:** the prompt now includes "If a concern is actually addressed
elsewhere in the docs, verify by reading that section before reporting it"
(reduces duplicates), and triage step 1 is mandatory `grep`/`read`
verification of every factual claim before acting on it.

## 3. Escalated majors resolved much faster with recommendations

**When:** presenting 11 majors to the operator.

**Symptom:** bare problem lists stall the operator; each presented *with a
recommended resolution* ("as recommended" / numbered answers) closed in one
round.

**Fix:** always escalate with a concrete recommendation per item.
