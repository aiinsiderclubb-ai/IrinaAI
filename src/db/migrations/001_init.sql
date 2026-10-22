CREATE TABLE kv (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- slot: google:work | google:personal | google:youtube | instagram
CREATE TABLE oauth_tokens (
  slot          text PRIMARY KEY,
  access_token  text,            -- encrypted (AES-256-GCM)
  refresh_token text,            -- encrypted
  expires_at    timestamptz,
  scope         text,
  meta          jsonb NOT NULL DEFAULT '{}',
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Every data-changing action waits here until the owner confirms (contract §2.5).
CREATE TABLE pending_actions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL,
  payload     jsonb NOT NULL,
  summary     text NOT NULL,
  status      text NOT NULL DEFAULT 'pending',   -- pending | done | cancelled | failed | expired
  chat_id     bigint,
  message_id  bigint,
  result      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX pending_actions_status ON pending_actions(status);

CREATE TABLE messages (
  id         bigserial PRIMARY KEY,
  chat_id    bigint NOT NULL,
  role       text NOT NULL,
  content    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_chat ON messages(chat_id, id DESC);

CREATE TABLE processed_updates (
  update_id bigint PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE job_runs (
  job        text NOT NULL,
  period     text NOT NULL,
  status     text NOT NULL,   -- running | done | failed
  attempts   int  NOT NULL DEFAULT 1,
  error      text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job, period)
);

-- Work <-> personal calendar mirroring
CREATE TABLE event_mirrors (
  src_account  text NOT NULL,
  src_event_id text NOT NULL,
  dst_account  text NOT NULL,
  dst_event_id text NOT NULL,
  start_at     timestamptz NOT NULL,
  fingerprint  text NOT NULL,
  PRIMARY KEY (src_account, src_event_id)
);

-- Notion task <-> calendar block created by "plan my day"
CREATE TABLE task_events (
  task_id  text PRIMARY KEY,
  account  text NOT NULL,
  event_id text NOT NULL
);

-- Daily Instagram / YouTube snapshots: the APIs only give a window, "dynamics" is built from these.
CREATE TABLE social_snapshots (
  platform text NOT NULL,
  taken_on date NOT NULL,
  data     jsonb NOT NULL,
  PRIMARY KEY (platform, taken_on)
);

CREATE TABLE seen_events (
  key        text PRIMARY KEY,
  title      text NOT NULL,
  first_seen timestamptz NOT NULL DEFAULT now()
);
