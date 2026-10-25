import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { Action } from "./plan";

const Output = z.object({
  actions: z.array(
    z.object({
      type: z.enum(["create", "update", "done"]),
      id: z.string().nullable(),
      title: z.string().nullable(),
      follow_up_in_minutes: z.number().nullable(),
    }),
  ),
});

const SYSTEM = `You track the tasks of a person with ADHD who narrates their work out loud.
Each message gives you a chunk of their speech transcript, their local time, and their open tasks.
Return the actions that keep the task list accurate:
- "create": a new task or something they must come back to. Short imperative title. id null.
- "update": an existing open task changed (new follow-up time or clearer title). Use its id.
- "done": they said an open task is finished. Use its id.
Set follow_up_in_minutes when they say when to check back ("in 4 minutes", "after lunch" ~ estimate from local time).
If something is waiting on an external process (deploy, build, reply) and no time is said, use 10.
Match existing tasks by meaning before creating a new one. Ignore chatter. No task-related content -> {"actions": []}.
The transcript comes from speech recognition and may contain mistakes; infer the intended words.`;

export async function extract(
  env: { ANTHROPIC_API_KEY: string; MODEL: string },
  text: string,
  localTime: string,
  open: { id: string; title: string; follow_up_at: number | null }[],
): Promise<{ actions: Action[]; raw: string }> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const response = await client.messages.parse({
    model: env.MODEL,
    max_tokens: 4000,
    system: SYSTEM,
    output_config: { effort: "low", format: zodOutputFormat(Output) },
    messages: [
      {
        role: "user",
        content: JSON.stringify({
          local_time: localTime,
          open_tasks: open.map((t) => ({
            id: t.id,
            title: t.title,
            follow_up_at: t.follow_up_at ? new Date(t.follow_up_at).toISOString() : null,
          })),
          transcript: text,
        }),
      },
    ],
  });
  const raw = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  if (response.stop_reason === "refusal") throw new Error(`refusal: ${raw}`);
  if (!response.parsed_output) throw new Error(`unparseable (${response.stop_reason}): ${raw}`);
  return { actions: response.parsed_output.actions, raw };
}
