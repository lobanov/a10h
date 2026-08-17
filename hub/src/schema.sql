-- Autoresearch hub schema v1 (M2)
CREATE TABLE IF NOT EXISTS nodes(
  id TEXT PRIMARY KEY,
  tags JSONB NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'idle',            -- idle | busy
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jobs(
  id TEXT PRIMARY KEY,
  plan_id TEXT,
  activity TEXT,
  image TEXT NOT NULL,
  command JSONB NOT NULL,
  requirements JSONB NOT NULL DEFAULT '{}',
  outputs JSONB NOT NULL DEFAULT '{}',
  inputs_evidence JSONB NOT NULL DEFAULT '[]',   -- [{path, content}] materialized into the checkout pre-run
  workspace_subdir TEXT,
  timeout_s INT NOT NULL DEFAULT 3600,
  status TEXT NOT NULL DEFAULT 'queued',         -- queued|leased|running|succeeded|failed|cancelled
  node TEXT,
  attempt INT NOT NULL DEFAULT 1,
  exit_code INT,
  cancel_requested BOOLEAN NOT NULL DEFAULT false,
  lease_expires TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs(status);


CREATE TABLE IF NOT EXISTS job_events(
  seq BIGSERIAL PRIMARY KEY,
  job_id TEXT NOT NULL,
  t NUMERIC, pct NUMERIC, eta_s NUMERIC,
  stage TEXT, metrics JSONB, state TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS job_events_job_idx ON job_events(job_id, seq);

CREATE TABLE IF NOT EXISTS artifacts(
  id BIGSERIAL PRIMARY KEY,
  job_id TEXT NOT NULL,
  kind TEXT NOT NULL,                            -- evidence | artifact
  path TEXT NOT NULL,
  content TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS artifacts_job_idx ON artifacts(job_id);

CREATE TABLE IF NOT EXISTS plans(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  goal_ref TEXT,
  repo_subdir TEXT,
  graph JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_approval', -- pending_approval|approved|executing|done|blocked
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS activities(
  plan_id TEXT NOT NULL,
  id TEXT NOT NULL,
  title TEXT,
  depends_on JSONB NOT NULL DEFAULT '[]',
  job JSONB NOT NULL,
  gate JSONB,
  expected_outcome TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
    -- pending|ready|running|gate_check|repair|passed|failed_final|escalated|resolved
  attempt INT NOT NULL DEFAULT 0,
  job_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(plan_id, id)
);

CREATE TABLE IF NOT EXISTS gate_results(
  id BIGSERIAL PRIMARY KEY,
  plan_id TEXT NOT NULL,
  activity TEXT NOT NULL,
  job_id TEXT,
  verdict TEXT NOT NULL,                          -- pass | fail
  checks JSONB NOT NULL,                          -- [{id, ok, detail}]
  reason TEXT,
  audit_note TEXT,                                -- auditor agent (M5), nullable until written
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS approvals(
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL,                             -- plan_approval | escalation
  plan_id TEXT,
  activity TEXT,
  payload JSONB NOT NULL,
  agent_note TEXT,                                -- director agent recommendation (M5)
  status TEXT NOT NULL DEFAULT 'pending',         -- pending|approved|rejected|resolved
  resolution JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS agent_log(
  id BIGSERIAL PRIMARY KEY,
  role TEXT NOT NULL,                             -- auditor | director
  event TEXT NOT NULL,
  data JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- R2 git plane: job carries its task branch (hub pre-created at promotion).
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS repo TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS branch TEXT;      -- refs/tasks/<activity>
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS base_sha TEXT;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS repo TEXT;        -- bare repo name (data/repos/<repo>.git)
ALTER TABLE activities ADD COLUMN IF NOT EXISTS merged_sha TEXT; -- set when the task branch lands on main

-- R2: one-time rebase/force authorizations, granted by the hub when a
-- landing turn requires a worker rebase; atomically consumed by the
-- pre-receive hook; unconsumed grants expire.
CREATE TABLE IF NOT EXISTS git_force_auth(
  id SERIAL PRIMARY KEY,
  repo TEXT NOT NULL,
  ref TEXT NOT NULL,
  job_id TEXT,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '1 hour'
);

-- R2: rebase instructions for held (non-ff) branches; delivered to workers
-- via SSE in R4, retried after LANDING_STALL_TIMEOUT_S.
CREATE TABLE IF NOT EXISTS rebase_instructions(
  id SERIAL PRIMARY KEY,
  repo TEXT NOT NULL,
  branch TEXT NOT NULL,
  job_id TEXT,
  target_main_sha TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'held',          -- held|delivered|done
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- R4: worker sessions (uniform-until-registered identity; one per container
-- lifetime) and the instruction outbox (bounded per session, at-least-once
-- delivery with idempotent acks; fresh buffer per SSE connect).
CREATE TABLE IF NOT EXISTS worker_sessions(
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'idle',        -- idle|busy|exited
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS worker_sessions_node_idx ON worker_sessions(node_id);

CREATE TABLE IF NOT EXISTS instruction_outbox(
  id SERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES worker_sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                        -- work_offer|gate_feedback|retrospective_prompt|repair|rebase|cancel|exit|custom
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ,
  acked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS instruction_outbox_session_idx ON instruction_outbox(session_id, acked_at);

-- R4: one-shot exit signaling (attempt closure); prevents re-killing a
-- node's future sessions for long-closed activities.
ALTER TABLE activities ADD COLUMN IF NOT EXISTS exit_signaled_at TIMESTAMPTZ;

-- R4: live-connection tracking — a session is offerable only while its SSE
-- stream is actually connected (zombie sessions from dead containers are
-- excluded immediately, not after the 90s freshness window).
ALTER TABLE worker_sessions ADD COLUMN IF NOT EXISTS streaming BOOLEAN NOT NULL DEFAULT false;

-- R4 review: bind each job offer to exactly one session (accept-time identity
-- check; prevents double-execution via late acks).
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS offer_session TEXT;
