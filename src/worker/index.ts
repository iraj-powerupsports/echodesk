import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { z } from "zod";
import type { Task } from "../shared/types";
import { extract } from "./claude";
import { planActions } from "./plan";

type Bindings = { DB: D1Database; ANTHROPIC_API_KEY: string; APP_TOKEN: string; MODEL: string };

const app = new Hono<{ Bindings: Bindings }>().basePath("/api");

app.use("*", async (c, next) => {
  if (!c.env.APP_TOKEN) return c.json({ error: "APP_TOKEN is not configured" }, 500);
  return bearerAuth<{ Bindings: Bindings }>({ token: c.env.APP_TOKEN })(c, next);
});

const listTasks = async (db: D1Database) =>
  (
    await db
      .prepare(
        `SELECT * FROM tasks WHERE status = 'open' OR updated_at > ?
         ORDER BY status DESC, follow_up_at IS NULL, follow_up_at, created_at DESC`,
      )
      .bind(Date.now() - 24 * 60 * 60_000)
      .all<Task>()
  ).results;

const UtteranceBody = z.object({ text: z.string().trim().min(1).max(4000), tz: z.string().max(64).optional() });

app.post("/utterance", async (c) => {
  const body = UtteranceBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "text is required (max 4000 chars)" }, 400);
  const db = c.env.DB;
  const now = Date.now();
  const uttId = crypto.randomUUID();
  // Save the transcript first so it survives any Claude failure.
  await db.prepare("INSERT INTO utterances (id, text, created_at) VALUES (?, ?, ?)").bind(uttId, body.data.text, now).run();

  const open = (
    await db.prepare("SELECT id, title, follow_up_at FROM tasks WHERE status = 'open'").all<Pick<Task, "id" | "title" | "follow_up_at">>()
  ).results;

  let localTime: string;
  try {
    localTime = new Date(now).toLocaleString("en-US", { timeZone: body.data.tz, dateStyle: "full", timeStyle: "short" });
  } catch {
    localTime = new Date(now).toISOString();
  }

  try {
    const { actions, raw } = await extract(c.env, body.data.text, localTime, open);
    const ops = planActions(actions, new Set(open.map((t) => t.id)), now, () => crypto.randomUUID());
    const event = (taskId: string, action: string) =>
      db
        .prepare("INSERT INTO task_events (id, task_id, utterance_id, action, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), taskId, uttId, action, now);
    const stmts = ops.flatMap((op) => {
      if (op.kind === "create")
        return [
          db
            .prepare("INSERT INTO tasks (id, title, follow_up_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
            .bind(op.id, op.title, op.follow_up_at, now, now),
          event(op.id, "create"),
        ];
      if (op.kind === "update")
        return [
          db
            .prepare("UPDATE tasks SET title = COALESCE(?, title), follow_up_at = COALESCE(?, follow_up_at), updated_at = ? WHERE id = ?")
            .bind(op.title, op.follow_up_at, now, op.id),
          event(op.id, "update"),
        ];
      return [db.prepare("UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ?").bind(now, op.id), event(op.id, "done")];
    });
    stmts.push(db.prepare("UPDATE utterances SET claude_raw = ? WHERE id = ?").bind(raw, uttId));
    await db.batch(stmts);
    return c.json({ tasks: await listTasks(db), changed: ops.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("utterance processing failed", message);
    await db.prepare("UPDATE utterances SET error = ? WHERE id = ?").bind(message.slice(0, 2000), uttId).run();
    return c.json({ tasks: await listTasks(db), error: "Couldn't process that — transcript saved." }, 502);
  }
});

app.get("/tasks", async (c) => c.json({ tasks: await listTasks(c.env.DB) }));

const PatchBody = z
  .object({ status: z.enum(["open", "done"]).optional(), follow_up_at: z.number().int().positive().nullable().optional() })
  .refine((b) => b.status !== undefined || b.follow_up_at !== undefined, "nothing to update");

app.patch("/tasks/:id", async (c) => {
  const body = PatchBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "status or follow_up_at required" }, 400);
  const { status, follow_up_at } = body.data;
  const id = c.req.param("id");
  const now = Date.now();
  const action = status === "done" ? "ui_done" : status === "open" ? "ui_reopen" : "ui_snooze";
  const [res] = await c.env.DB.batch([
    c.env.DB
      .prepare(
        `UPDATE tasks SET status = COALESCE(?, status),
         follow_up_at = CASE WHEN ? THEN ? ELSE follow_up_at END, updated_at = ? WHERE id = ?`,
      )
      .bind(status ?? null, follow_up_at !== undefined ? 1 : 0, follow_up_at ?? null, now, id),
    c.env.DB
      .prepare(
        "INSERT INTO task_events (id, task_id, utterance_id, action, created_at) SELECT ?, id, NULL, ?, ? FROM tasks WHERE id = ?",
      )
      .bind(crypto.randomUUID(), action, now, id),
  ]);
  if (!res.meta.changes) return c.json({ error: "not found" }, 404);
  return c.json({ tasks: await listTasks(c.env.DB) });
});

app.get("/tasks/:id/history", async (c) => {
  const { results } = await c.env.DB
    .prepare(
      `SELECT e.action, e.created_at, u.text FROM task_events e
       LEFT JOIN utterances u ON u.id = e.utterance_id WHERE e.task_id = ? ORDER BY e.created_at`,
    )
    .bind(c.req.param("id"))
    .all();
  return c.json({ events: results });
});

app.get("/utterances", async (c) => {
  const limit = Math.min(Number(c.req.query("limit")) || 50, 200);
  const before = Number(c.req.query("before")) || Date.now() + 1;
  const { results } = await c.env.DB
    .prepare(
      `SELECT u.*, (SELECT json_group_array(json_object('task_id', e.task_id, 'action', e.action, 'title', t.title))
         FROM task_events e JOIN tasks t ON t.id = e.task_id WHERE e.utterance_id = u.id) AS events
       FROM utterances u WHERE u.created_at < ? ORDER BY u.created_at DESC LIMIT ?`,
    )
    .bind(before, limit)
    .all<Record<string, unknown> & { events: string }>();
  return c.json({ utterances: results.map((u) => ({ ...u, events: JSON.parse(u.events) })) });
});

export default app;
