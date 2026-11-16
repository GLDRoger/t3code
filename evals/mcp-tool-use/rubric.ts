import * as Schema from "effect/Schema";

/**
 * A judgement no regex can make, such as "does this read like the character", asked of a judge
 * model as yes/no questions about the turn's visible reply and the calls it made.
 */
export const Rubric = Schema.Struct({
  /** Each a question whose right answer is yes for a passing reply. */
  checks: Schema.Array(Schema.String),
  /** What the judge needs beside the reply, such as the character the agent was given. */
  context: Schema.optional(Schema.String),
});
export type Rubric = typeof Rubric.Type;

const JUDGE_PROMPT =
  'You grade one reply an AI colleague wrote in a company chat app. Answer each question about the reply strictly: yes only when the reply clearly meets it. Judge the words a person would read, plus the tool calls listed (a card the agent posted counts as its message). Keep each why to one sentence. Answer with JSON only, one verdict per question in order: {"verdicts": [{"answer": true, "why": "..."}]}';

export const rubricRequest = (
  model: string,
  rubric: Rubric,
  turn: { readonly text: string; readonly calls: ReadonlyArray<string> },
) => ({
  model,
  max_tokens: 2_000,
  system: JUDGE_PROMPT,
  messages: [
    {
      role: "user",
      content: [
        ...(rubric.context === undefined ? [] : [`Context:\n${rubric.context}`]),
        `The reply:\n<reply>\n${turn.text}\n</reply>`,
        `Tool calls it made:\n${turn.calls.length === 0 ? "(none)" : turn.calls.join("\n")}`,
        `Questions, in order:\n${rubric.checks.map((check, index) => `${index + 1}. ${check}`).join("\n")}`,
      ]
        .join("\n\n")
        .split("\n\n")
        .map((part) => ({ type: "text", text: part })),
    },
  ],
});

const decodeVerdicts = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      verdicts: Schema.Array(Schema.Struct({ answer: Schema.Boolean, why: Schema.String })),
    }),
  ),
);

/** One check per question; a missing or unreadable verdict fails that question. */
export const rubricChecks = (
  rubric: Rubric,
  content: ReadonlyArray<{ type: string; text?: string }>,
) => {
  const text = content
    .flatMap((block) => (block.type === "text" ? [block.text ?? ""] : []))
    .join("");
  const verdicts = decodeVerdicts(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  return rubric.checks.map((check, index) => {
    const verdict = verdicts._tag === "Some" ? verdicts.value.verdicts[index] : undefined;
    return {
      check: `rubric ${check}`,
      pass: verdict?.answer === true,
      ...(verdict === undefined ? {} : { why: verdict.why }),
    };
  });
};
