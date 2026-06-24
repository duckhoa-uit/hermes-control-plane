-- Hermes Control Plane - D1 Schema
-- Run: wrangler d1 execute hermes-db --local --file=schema.sql

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  repo_url TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  setup_script TEXT,
  test_script TEXT,
  agents_context TEXT,
  model TEXT NOT NULL DEFAULT 'claude-sonnet-4-20250514',
  allowed_tools TEXT NOT NULL DEFAULT '["read","edit","bash","grep","glob"]',
  auto_allow TEXT NOT NULL DEFAULT '["file.read","file.edit","test.run"]',
  require_approval TEXT NOT NULL DEFAULT '["git.push","pr.create","shell.destructive"]',
  env_vars TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created',
  branch TEXT NOT NULL,
  sandbox_id TEXT,
  runner_connected INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS session_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  UNIQUE(session_id, seq)
);

CREATE TABLE IF NOT EXISTS session_artifacts (
  session_id TEXT PRIMARY KEY,
  summary TEXT,
  diff TEXT,
  changed_files TEXT NOT NULL DEFAULT '[]',
  test_passed INTEGER,
  test_total INTEGER,
  test_failed INTEGER,
  test_output TEXT,
  pr_url TEXT,
  logs_url TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_events_session ON session_events(session_id);
