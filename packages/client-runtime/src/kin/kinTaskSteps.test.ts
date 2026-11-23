import { describe, expect, it } from "vite-plus/test";

import { KIN_TASKS } from "./kinTasksList.ts";
import { createKinTaskSteps, type KinTaskStepsState } from "./kinTaskSteps.ts";

type Answer = { readonly ok: true } | { readonly ok: false; readonly cause: unknown };

describe("createKinTaskSteps", () => {
  it("nudges a row once: not again while it is on its way, nor after it went; again after a failure", async () => {
    const seen: Array<KinTaskStepsState> = [];
    const steps = createKinTaskSteps({
      newId: () => "id",
      post: async () => ({ ok: true }),
      onChange: (state) => seen.push(state),
    });
    const answers: Array<(answer: Answer) => void> = [];
    const send = () => new Promise<Answer>((resolve) => answers.push(resolve));

    const first = steps.nudge("TK-1", send);
    const second = steps.nudge("TK-1", send);
    expect(answers).toHaveLength(1);
    expect(seen.at(-1)?.status["TK-1"]).toEqual({ kind: "busy", id: "nudge" });
    answers[0]!({ ok: true });
    await Promise.all([first, second]);
    expect(seen.at(-1)).toEqual({ status: {}, nudged: new Set(["TK-1"]) });

    await steps.nudge("TK-1", send);
    expect(answers).toHaveLength(1);

    const other = steps.nudge("TK-2", send);
    answers[1]!({ ok: false, cause: undefined });
    await other;
    expect(seen.at(-1)?.status["TK-2"]).toMatchObject({ kind: "failed" });
    expect(seen.at(-1)?.status["TK-2"]).toHaveProperty(
      "text",
      expect.stringContaining(KIN_TASKS.nudgeFailed),
    );
    void steps.nudge("TK-2", send);
    expect(answers).toHaveLength(3);
  });
});
