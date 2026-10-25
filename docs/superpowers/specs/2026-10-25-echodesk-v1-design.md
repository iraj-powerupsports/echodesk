# EchoDesk v1 — Design

## Problem
Out of sight, out of mind: tasks and follow-ups slip once attention moves on. Speaking work aloud
("deploying, I'll check in 4 min") is a free signal nobody captures. EchoDesk listens, extracts tasks and
follow-up times with Claude, and pulls the user back when they are due.

## Success criteria
- Saying "check in 4 minutes" produces a visible countdown and, at zero, a browser notification + sound.
- Overdue tasks stay visibly pinned until marked Done or snoozed.
- Deployed publicly on free-tier hosting; single user.

## Non-goals (v1)
Slack/phone push, team sharing, accounts/multi-user, native Mac wrapper, Whisper/local STT, spoken nudges.

## Architecture
- **Frontend:** React + Vite, served by Cloudflare Pages (or by the Worker's static assets).
- **API:** Hono on a Cloudflare Worker.
- **DB:** Cloudflare D1 (SQLite).
- **STT:** browser Web Speech API (`webkitSpeechRecognition`, continuous). Auto-restart on `onend` while the
  listening toggle is on. Audio goes to the browser vendor's servers; do not dictate secrets.
- **LLM:** Claude API (Haiku-class model) called from the Worker; key stored as a Worker secret.
- **Auth:** single shared secret (`APP_TOKEN`) sent as a bearer header; the UI asks for it once and keeps it
  in localStorage. Prevents strangers from spending Claude tokens on the public URL.

## Data model (D1)
```sql
CREATE TABLE tasks (
  id          TEXT PRIMARY KEY,           -- uuid
  title       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open', -- open | done
  follow_up_at INTEGER,                    -- unix ms, nullable
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE TABLE utterances (
  id TEXT PRIMARY KEY, text TEXT NOT NULL, created_at INTEGER NOT NULL,
  claude_raw TEXT,                         -- raw model reply, kept to debug/improve the prompt
  error TEXT                               -- parse/API failure, if any
);
-- Links every utterance to the tasks it touched (create/update/done), so a task's full history is queryable.
CREATE TABLE task_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  utterance_id TEXT REFERENCES utterances(id), -- NULL for UI-originated events
  action TEXT NOT NULL,                    -- create | update | done
  created_at INTEGER NOT NULL
);
CREATE INDEX task_events_task ON task_events(task_id);
CREATE INDEX task_events_utt ON task_events(utterance_id);
```
UI actions (Done/Snooze clicks) also write a `task_events` row with `utterance_id` NULL and
`action = 'ui_done' | 'ui_snooze'`, so `task_events.utterance_id` is nullable.
Utterances are never deleted by the app; a manual `DELETE FROM utterances` is the v1 privacy lever.

## Endpoints (all require `Authorization: Bearer APP_TOKEN`)
- `POST /api/utterance` `{text, now}` → stores the utterance, sends it plus the open tasks to Claude,
  applies the returned actions in one D1 batch, returns the updated open task list.
- `GET /api/tasks` → open tasks plus tasks done in the last 24h.
- `PATCH /api/tasks/:id` `{status?, follow_up_at?}` → Done / Snooze buttons; writes a `ui_*` task event.
- `GET /api/tasks/:id/history` → the task's events joined to their utterance text, oldest first.
- `GET /api/utterances?limit=&before=` → raw transcript log with `claude_raw` and the tasks each touched,
  for reviewing what Claude got wrong. In the UI: a "History" panel per task plus a transcript log page.

## Claude contract
Input: transcript chunk, `now` (ISO, user timezone), list of open tasks `{id, title, follow_up_at}`.
Output: strict JSON, validated with zod; invalid output is dropped (utterance still saved) and logged.
```json
{ "actions": [
  { "type": "create", "title": "Check deploy", "follow_up_in_minutes": 4 },
  { "type": "update", "id": "…", "follow_up_in_minutes": 10 },
  { "type": "done",   "id": "…" }
] }
```
Server converts `follow_up_in_minutes` to absolute `follow_up_at` using server time. Chatter with no task
returns `{"actions": []}`. Prompt rule: match existing tasks by meaning before creating new ones.

## UI
1. Listening toggle with live transcript line.
2. Task list: title, status, countdown to follow-up; overdue rows red and sorted first.
3. Overdue banner at the top while any task is overdue.
4. Alerts: client timer per task; at due time, fire `Notification` + short sound with Done / Snooze (5 min).
   Notification permission is requested on first Listening toggle (needs a user gesture).
   Tab also re-syncs `GET /api/tasks` every 30s and on focus.

## Error handling
- STT unsupported (non-Chromium): show a message; typed-input box is the fallback and uses the same endpoint.
- Claude/API failure: utterance saved, task list unchanged, small "couldn't process" toast, no retry loop.
- Notification denied: in-page banner + title-bar flashing still show overdue state.

## Testing
- Unit: zod action parsing; action-applier (create/update/done) against an in-memory SQLite/D1 mock.
- Unit: minutes → `follow_up_at` conversion.
- Manual: dictate "deploying, check in 1 minute" and confirm the alert fires.

## Deploy
`wrangler d1 create`, apply `schema.sql`, `wrangler secret put ANTHROPIC_API_KEY APP_TOKEN`, `wrangler deploy`.

## Known limits (shortcuts)
- Tab must stay open to alert; upgrade to a PWA/native wrapper or phone push later.
- Web Speech accuracy on technical terms is mediocre; upgrade path is Whisper behind the same `/utterance` API.
- Single user and one shared token; add real auth only if others join.
