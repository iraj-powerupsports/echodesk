CREATE TABLE IF NOT EXISTS tasks (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open',  -- open | done
  follow_up_at INTEGER,                       -- unix ms
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS utterances (
  id         TEXT PRIMARY KEY,
  text       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  claude_raw TEXT,  -- raw model reply, kept to debug/improve the prompt
  error      TEXT
);
CREATE TABLE IF NOT EXISTS task_events (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES tasks(id),
  utterance_id TEXT REFERENCES utterances(id),  -- NULL for UI-originated events
  action       TEXT NOT NULL,                   -- create | update | done | ui_done | ui_snooze | ui_reopen
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS task_events_task ON task_events(task_id);
CREATE INDEX IF NOT EXISTS task_events_utt ON task_events(utterance_id);
CREATE INDEX IF NOT EXISTS utterances_created ON utterances(created_at);
