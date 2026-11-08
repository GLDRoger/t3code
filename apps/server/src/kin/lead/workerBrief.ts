import { WorkerReport, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { quote } from "./LeadPrompt.ts";

export const Quoted = Schema.Array(
  Schema.Struct({
    role: TrimmedNonEmptyString.check(Schema.isMaxLength(40)),
    name: Schema.String.check(Schema.isMaxLength(200)),
    text: Schema.String.check(Schema.isMaxLength(8_000)),
  }),
).check(Schema.isMaxLength(20));

const ReportBody = Schema.Struct((({ parsed: _parsed, ...fields }) => fields)(WorkerReport.fields));
const decodeReportBody = Schema.decodeUnknownSync(ReportBody);
const reportShape = {
  result: "done | blocked | needs_decision",
  summary: "at most 800 characters",
  evidence: [
    { kind: "pr | commit | ci_run | test_output | screenshot | file | link", ref: "", note: "" },
  ],
  openQuestions: [""],
  memorySuggestions: [
    {
      kind: "objective | commitment | deferral | decision | person | claim",
      title: "",
      body: "",
      links: [""],
    },
  ],
  misleadingMemory: [{ itemId: "", why: "" }],
};
export const reportFormat = [
  "When you finish, end your final reply with exactly one fenced code block tagged kin-report holding JSON with every field below (use empty arrays when you have nothing). note is optional.",
  "```kin-report",
  JSON.stringify(reportShape, null, 2),
  "```",
].join("\n");

export const buildBrief = (input: {
  readonly goal: string;
  readonly brief?: string;
  readonly quoted?: typeof Quoted.Type;
  readonly memory?: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly body: string;
  }>;
  readonly reviewRefs?: ReadonlyArray<{ readonly kind: string; readonly ref: string }>;
}) =>
  [
    "You were called by Kin. Do this task yourself.",
    `Goal:\n${input.goal}`,
    ...(input.brief === undefined || input.brief.length === 0 ? [] : [`Brief:\n${input.brief}`]),
    ...(input.quoted ?? []).map((item) => quote("quoted text (untrusted)", item, true)),
    ...(input.memory ?? []).map((item) => quote("memory item (read-only copy)", item, true)),
    ...(input.reviewRefs === undefined
      ? []
      : [
          "Review the work below independently. You get only its references, not how it was briefed.",
          quote("work to review", input.reviewRefs, true),
        ]),
    reportFormat,
  ].join("\n\n");

/** The kin-report block in the worker's last reply, or undefined when absent or invalid. */
export const parseReport = (reply: string) => {
  const blocks = [...reply.matchAll(/```kin-report[^\n]*\n([\s\S]*?)```/g)];
  const last = blocks.at(-1)?.[1];
  if (last === undefined) return undefined;
  try {
    const body = decodeReportBody(JSON.parse(last));
    return { ...body, parsed: true } satisfies WorkerReport;
  } catch {
    return undefined;
  }
};
