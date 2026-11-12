-- Projects as working folders: one Notion page (brief, sub-pages, files, links) + everything sent in chat.
CREATE TABLE projects (
  id          bigserial PRIMARY KEY,
  name        text NOT NULL,
  notion_id   text,                            -- root page (or database) id
  notion_url  text,
  summary     text NOT NULL DEFAULT '',        -- the project card the assistant keeps in mind
  status      text NOT NULL DEFAULT 'active',  -- active | archived
  synced_at   timestamptz,
  sync_error  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX projects_status ON projects (status);

-- Everything the assistant can read about a project: Notion pages and tables, files, web pages, long chat messages, reports.
CREATE TABLE materials (
  id          bigserial PRIMARY KEY,
  project_id  bigint REFERENCES projects(id) ON DELETE CASCADE,  -- NULL = not tied to a project
  kind        text NOT NULL,          -- notion | notion_db | file | link | chat | note | report
  title       text NOT NULL,
  source      text,                   -- Notion id, URL or file name
  text        text NOT NULL DEFAULT '',
  meta        jsonb NOT NULL DEFAULT '{}',
  hash        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX materials_project ON materials (project_id, kind);
CREATE INDEX materials_source ON materials (source);

-- Pieces of materials with embeddings for search by meaning.
CREATE TABLE material_chunks (
  id           bigserial PRIMARY KEY,
  material_id  bigint NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  project_id   bigint,
  idx          int NOT NULL,
  text         text NOT NULL,
  embedding    bytea                  -- float32 vector; NULL when embeddings are unavailable
);
CREATE INDEX material_chunks_material ON material_chunks (material_id);
CREATE INDEX material_chunks_project ON material_chunks (project_id);

-- Long assignments the assistant works on in the background.
CREATE TABLE agent_jobs (
  id           bigserial PRIMARY KEY,
  chat_id      bigint NOT NULL,
  project_id   bigint REFERENCES projects(id) ON DELETE SET NULL,
  goal         text NOT NULL,
  status       text NOT NULL DEFAULT 'running',   -- running | done | failed | cancelled
  progress     text NOT NULL DEFAULT '',
  result       text,
  steps        int NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);
CREATE INDEX agent_jobs_status ON agent_jobs (status);
