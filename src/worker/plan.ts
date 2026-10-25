export type Action = {
  type: "create" | "update" | "done";
  id: string | null;
  title: string | null;
  follow_up_in_minutes: number | null;
};

export type Op =
  | { kind: "create"; id: string; title: string; follow_up_at: number | null }
  | { kind: "update"; id: string; title: string | null; follow_up_at: number | null }
  | { kind: "done"; id: string };

const MAX_MINUTES = 7 * 24 * 60;

export function followUpAt(minutes: number | null, now: number): number | null {
  if (minutes == null || !Number.isFinite(minutes) || minutes <= 0) return null;
  return now + Math.min(minutes, MAX_MINUTES) * 60_000;
}

/** Turns model actions into DB ops, dropping anything that references a task we don't have. */
export function planActions(actions: Action[], openIds: Set<string>, now: number, newId: () => string): Op[] {
  const ops: Op[] = [];
  for (const a of actions) {
    const title = a.title?.trim() || null;
    const at = followUpAt(a.follow_up_in_minutes, now);
    if (a.type === "create") {
      if (title) ops.push({ kind: "create", id: newId(), title, follow_up_at: at });
    } else if (a.id && openIds.has(a.id)) {
      if (a.type === "done") ops.push({ kind: "done", id: a.id });
      else if (title || at) ops.push({ kind: "update", id: a.id, title, follow_up_at: at });
    }
  }
  return ops;
}
