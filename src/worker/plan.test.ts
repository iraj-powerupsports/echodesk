import { describe, expect, it } from "vitest";
import { followUpAt, planActions } from "./plan";

const now = 1_000_000;
let n = 0;
const newId = () => `new${++n}`;

describe("followUpAt", () => {
  it("converts minutes to absolute ms", () => expect(followUpAt(4, now)).toBe(now + 240_000));
  it("ignores null, zero, negative and NaN", () => {
    for (const m of [null, 0, -3, NaN]) expect(followUpAt(m, now)).toBeNull();
  });
  it("caps at 7 days", () => expect(followUpAt(1e9, now)).toBe(now + 7 * 24 * 60 * 60_000));
});

describe("planActions", () => {
  const open = new Set(["t1"]);

  it("creates tasks with a follow-up", () => {
    const ops = planActions([{ type: "create", id: null, title: " Check deploy ", follow_up_in_minutes: 4 }], open, now, newId);
    expect(ops).toEqual([{ kind: "create", id: "new1", title: "Check deploy", follow_up_at: now + 240_000 }]);
  });

  it("drops creates without a title", () => {
    expect(planActions([{ type: "create", id: null, title: "  ", follow_up_in_minutes: 4 }], open, now, newId)).toEqual([]);
  });

  it("updates and completes known tasks only", () => {
    const ops = planActions(
      [
        { type: "update", id: "t1", title: null, follow_up_in_minutes: 10 },
        { type: "done", id: "t1", title: null, follow_up_in_minutes: null },
        { type: "done", id: "ghost", title: null, follow_up_in_minutes: null },
        { type: "update", id: "t1", title: null, follow_up_in_minutes: null },
      ],
      open,
      now,
      newId,
    );
    expect(ops).toEqual([
      { kind: "update", id: "t1", title: null, follow_up_at: now + 600_000 },
      { kind: "done", id: "t1" },
    ]);
  });
});
