-- Long-term memory: people, preferences, facts the owner told the assistant.
CREATE TABLE memories (
  id         bigserial PRIMARY KEY,
  subject    text NOT NULL,
  content    text NOT NULL,
  kind       text NOT NULL DEFAULT 'fact',   -- person | preference | fact
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memories_subject ON memories (lower(subject));

-- Proactive messages: one row per event, so nothing is said twice.
CREATE TABLE nudges (
  key        text PRIMARY KEY,
  text       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX nudges_created ON nudges (created_at);
