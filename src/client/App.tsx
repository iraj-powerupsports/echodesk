import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import type { Task, TaskEvent, Utterance } from "../shared/types";
import { api, ApiError, AuthError, getToken, setToken } from "./api";
import { useSpeech } from "./useSpeech";

const SNOOZE_MS = 5 * 60_000;
const FLUSH_AFTER_SILENCE_MS = 2500;
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

function countdown(ms: number) {
  const s = Math.round(Math.abs(ms) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const text = h ? `${h}h ${m}m` : `${m}:${String(s % 60).padStart(2, "0")}`;
  return ms < 0 ? `overdue ${text}` : `in ${text}`;
}

const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

let audio: AudioContext | null = null;
function beep() {
  if (!audio) return;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.frequency.value = 880;
  gain.gain.setValueAtTime(0.2, audio.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.6);
  osc.connect(gain).connect(audio.destination);
  osc.start();
  osc.stop(audio.currentTime + 0.6);
}

export default function App() {
  const [authed, setAuthed] = useState(!!getToken());
  return authed ? <Main onAuthError={() => (setToken(null), setAuthed(false))} /> : <TokenGate onDone={() => setAuthed(true)} />;
}

function TokenGate({ onDone }: { onDone: () => void }) {
  const [value, setValue] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setToken(value.trim());
    onDone();
  };
  return (
    <main className="gate">
      <h1>EchoDesk</h1>
      <form onSubmit={submit}>
        <label htmlFor="token">Access token</label>
        <input id="token" type="password" value={value} onChange={(e) => setValue(e.target.value)} autoFocus required />
        <button type="submit">Continue</button>
      </form>
    </main>
  );
}

function Main({ onAuthError }: { onAuthError: () => void }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [now, setNow] = useState(Date.now());
  const [view, setView] = useState<"tasks" | "log">("tasks");
  const [toast, setToast] = useState<string | null>(null);
  const [lastHeard, setLastHeard] = useState("");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(0);
  const alerted = useRef(new Set<string>());
  const buffer = useRef<string[]>([]);
  const flushTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const call = useCallback(
    async (path: string, init?: { method?: string; body?: unknown }) => {
      try {
        const data = await api<{ tasks: Task[] }>(path, init);
        setTasks(data.tasks);
      } catch (err) {
        if (err instanceof AuthError) return onAuthError();
        if (err instanceof ApiError && Array.isArray(err.data.tasks)) setTasks(err.data.tasks as Task[]);
        setToast(err instanceof Error ? err.message : "Request failed");
      }
    },
    [onAuthError],
  );

  const send = useCallback(
    async (text: string) => {
      setBusy((b) => b + 1);
      await call("/utterance", { method: "POST", body: { text, tz } });
      setBusy((b) => b - 1);
    },
    [call],
  );

  // Group phrases until a pause so "deploying… check in 4 minutes" reaches Claude as one thought.
  const flush = useCallback(() => {
    const text = buffer.current.join(" ").trim();
    buffer.current = [];
    if (text) send(text);
  }, [send]);

  const speech = useSpeech((text) => {
    if (!text) return;
    setLastHeard(text);
    buffer.current.push(text);
    clearTimeout(flushTimer.current);
    flushTimer.current = setTimeout(flush, FLUSH_AFTER_SILENCE_MS);
  });

  const toggleListening = () => {
    if (speech.listening) {
      speech.stop();
      clearTimeout(flushTimer.current);
      flush();
      return;
    }
    // Both need a user gesture, so unlock them on this click.
    audio ??= new AudioContext();
    if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
    speech.start();
  };

  // Load, then re-sync every 30s and when the tab regains focus.
  useEffect(() => {
    const load = () => call("/tasks");
    load();
    const id = setInterval(load, 30_000);
    window.addEventListener("focus", load);
    return () => (clearInterval(id), window.removeEventListener("focus", load));
  }, [call]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const open = tasks.filter((t) => t.status === "open");
  const overdue = open.filter((t) => t.follow_up_at && t.follow_up_at <= now);

  useEffect(() => {
    document.title = overdue.length ? `(${overdue.length}) ⏰ EchoDesk` : "EchoDesk";
    for (const t of overdue) {
      const key = `${t.id}:${t.follow_up_at}`;
      if (alerted.current.has(key)) continue;
      alerted.current.add(key);
      beep();
      if ("Notification" in window && Notification.permission === "granted") {
        const n = new Notification(`⏰ ${t.title}`, { body: "Follow-up is due. Back to it?", tag: t.id, requireInteraction: true });
        n.onclick = () => (window.focus(), n.close());
      }
    }
  }, [overdue]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(id);
  }, [toast]);

  const submitTyped = (e: FormEvent) => {
    e.preventDefault();
    if (!typed.trim()) return;
    send(typed.trim());
    setTyped("");
  };

  const patch = (id: string, body: object) => call(`/tasks/${id}`, { method: "PATCH", body });
  const sorted = [...open].sort((a, b) => (a.follow_up_at ?? Infinity) - (b.follow_up_at ?? Infinity));
  const done = tasks.filter((t) => t.status === "done");

  return (
    <main>
      <header>
        <h1>EchoDesk</h1>
        <nav aria-label="View">
          <button aria-pressed={view === "tasks"} onClick={() => setView("tasks")}>Tasks</button>
          <button aria-pressed={view === "log"} onClick={() => setView("log")}>Transcript log</button>
        </nav>
      </header>

      <section className="listen">
        {speech.supported ? (
          <button className={speech.listening ? "mic on" : "mic"} onClick={toggleListening} aria-pressed={speech.listening}>
            {speech.listening ? "● Listening — click to stop" : "🎙 Start listening"}
          </button>
        ) : (
          <p className="warn">Voice input needs Chrome or Edge. You can still type below.</p>
        )}
        {speech.error && <p className="warn">{speech.error}</p>}
        <p className="heard" aria-live="polite">
          {speech.interim || lastHeard || "Say what you're doing, e.g. “deploying the API, check back in 4 minutes”."}
          {busy > 0 && <span className="muted"> · thinking…</span>}
        </p>
        <form onSubmit={submitTyped} className="typed">
          <label htmlFor="typed" className="sr-only">Type an update</label>
          <input id="typed" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="…or type an update" />
          <button type="submit">Send</button>
        </form>
      </section>

      {overdue.length > 0 && (
        <div className="banner" role="alert">
          ⏰ {overdue.length} follow-up{overdue.length > 1 ? "s" : ""} due: {overdue.map((t) => t.title).join(", ")}
        </div>
      )}

      {view === "tasks" ? (
        <>
          <ul className="tasks">
            {sorted.map((t) => (
              <TaskRow key={t.id} task={t} now={now} onPatch={patch} />
            ))}
            {!sorted.length && <li className="muted">No open tasks. Start talking.</li>}
          </ul>
          {done.length > 0 && (
            <>
              <h2>Done (last 24h)</h2>
              <ul className="tasks done">
                {done.map((t) => (
                  <TaskRow key={t.id} task={t} now={now} onPatch={patch} />
                ))}
              </ul>
            </>
          )}
        </>
      ) : (
        <Log onAuthError={onAuthError} />
      )}

      {toast && <div className="toast" role="status">{toast}</div>}
    </main>
  );
}

function TaskRow({ task, now, onPatch }: { task: Task; now: number; onPatch: (id: string, body: object) => void }) {
  const [history, setHistory] = useState<TaskEvent[] | null>(null);
  const due = task.follow_up_at ? task.follow_up_at - now : null;
  const toggleHistory = async () => {
    if (history) return setHistory(null);
    try {
      setHistory((await api<{ events: TaskEvent[] }>(`/tasks/${task.id}/history`)).events);
    } catch {
      setHistory([]);
    }
  };
  return (
    <li className={due !== null && due <= 0 && task.status === "open" ? "overdue" : ""}>
      <div className="row">
        <span className="title">{task.title}</span>
        {task.status === "open" && due !== null && <span className="due">{countdown(due)}</span>}
        <span className="actions">
          {task.status === "open" ? (
            <>
              <button onClick={() => onPatch(task.id, { status: "done" })}>Done</button>
              <button onClick={() => onPatch(task.id, { follow_up_at: Date.now() + SNOOZE_MS })}>Remind in 5m</button>
            </>
          ) : (
            <button onClick={() => onPatch(task.id, { status: "open" })}>Reopen</button>
          )}
          <button onClick={toggleHistory} aria-expanded={!!history}>History</button>
        </span>
      </div>
      {history && (
        <ol className="history">
          {!history.length && <li className="muted">No history yet.</li>}
          {history.map((e, i) => (
            <li key={i}>
              <span className="muted">{time(e.created_at)} · {e.action}</span> {e.text && <q>{e.text}</q>}
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}

function Log({ onAuthError }: { onAuthError: () => void }) {
  const [items, setItems] = useState<Utterance[]>([]);
  const [more, setMore] = useState(true);
  const load = useCallback(
    async (before?: number) => {
      try {
        const { utterances } = await api<{ utterances: Utterance[] }>(`/utterances?limit=50${before ? `&before=${before}` : ""}`);
        setItems((prev) => (before ? [...prev, ...utterances] : utterances));
        setMore(utterances.length === 50);
      } catch (err) {
        if (err instanceof AuthError) onAuthError();
      }
    },
    [onAuthError],
  );
  useEffect(() => void load(), [load]);
  return (
    <section>
      <ul className="log">
        {items.map((u) => (
          <li key={u.id}>
            <div>
              <span className="muted">{new Date(u.created_at).toLocaleString()}</span> <q>{u.text}</q>
            </div>
            {u.events.length > 0 && (
              <div className="muted">→ {u.events.map((e) => `${e.action}: ${e.title}`).join(" · ")}</div>
            )}
            {u.error && <div className="warn">error: {u.error}</div>}
            {u.claude_raw && (
              <details>
                <summary>Claude reply</summary>
                <pre>{u.claude_raw}</pre>
              </details>
            )}
          </li>
        ))}
      </ul>
      {more && items.length > 0 && <button onClick={() => load(items[items.length - 1].created_at)}>Load older</button>}
    </section>
  );
}
