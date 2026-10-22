-- One-time login links for the web UI, sent by the bot (/web). Only the hash is stored.
CREATE TABLE web_login_tokens (
  token_hash text PRIMARY KEY,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);
