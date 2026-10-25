export type Task = {
  id: string;
  title: string;
  status: "open" | "done";
  follow_up_at: number | null;
  created_at: number;
  updated_at: number;
};

export type TaskEvent = { action: string; created_at: number; text: string | null };

export type Utterance = {
  id: string;
  text: string;
  created_at: number;
  claude_raw: string | null;
  error: string | null;
  events: { task_id: string; action: string; title: string }[];
};
