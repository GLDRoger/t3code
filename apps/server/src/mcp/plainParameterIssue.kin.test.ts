import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { plainParameterIssue } from "./plainParameterIssue.ts";

const PlainInput = Schema.Struct({
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  kind: Schema.Literals(["call", "meeting", "email", "message", "other"]),
  count: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  tasks: Schema.Array(Schema.Struct({ reason: Schema.String })).check(Schema.isMaxLength(2)),
});
const decodePlainInput = Schema.decodeUnknownEffect(Schema.toCodecJson(PlainInput));
const plain = { title: "Invented call", kind: "call", tasks: [{ reason: "Invented" }] };
it.effect.each([
  [{ ...plain, tasks: [{}] }, "tasks[0].reason is missing."],
  [{ ...plain, title: "x".repeat(300) }, "title is 300 characters; at most 200."],
  [{ ...plain, title: "" }, "title is 0 characters; at least 1."],
  [
    { ...plain, tasks: [plain.tasks[0], plain.tasks[0], plain.tasks[0]] },
    "tasks is 3 items; at most 2.",
  ],
  [{ ...plain, kind: "visit" }, "kind must be one of call, meeting, email, message, other."],
  [{ ...plain, title: 3 }, "title must be text."],
  [{ ...plain, tasks: "none" }, "tasks must be a list."],
  [{ ...plain, count: 0 }, undefined],
  [{ title: "Invented call", tasks: [] }, "kind is missing."],
] as const)("puts a bad argument plainly: %j", ([input, sentence]) =>
  Effect.gen(function* () {
    const issue = yield* Effect.flip(decodePlainInput(input, { errors: "all", reportInput: true }));
    expect(plainParameterIssue(issue.issue)).toBe(sentence);
  }),
);
