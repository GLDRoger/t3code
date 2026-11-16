import * as Schema from "effect/Schema";

/**
 * Countable limits on the visible reply, graded in three bands: at or under the limit passes,
 * a little over passes "within margin", and more fails. The owner chose to stop chasing exact
 * lengths for agent voices; the word ceilings stay in the characters as targets.
 */
export const Limits = Schema.Struct({
  /** Characters. Up to 50% over is within margin. */
  chars: Schema.optional(Schema.Number),
  /** For each count below, one over is within margin. */
  emoji: Schema.optional(Schema.Number),
  exclamations: Schema.optional(Schema.Number),
  questions: Schema.optional(Schema.Number),
  /** Lines that start with `-` or `*` and a space. */
  bullets: Schema.optional(Schema.Number),
  /** Blocks separated by a blank line. */
  paragraphs: Schema.optional(Schema.Number),
});
export type Limits = typeof Limits.Type;

/**
 * A case passes when at least `passes` of every `of` finished samples pass, within margin or not.
 * Without it, a case passes when more than half its samples pass.
 */
export const CaseMargin = Schema.Struct({ passes: Schema.Number, of: Schema.Number });
export type CaseMargin = typeof CaseMargin.Type;

export type State = "pass" | "margin" | "fail";
export interface Check {
  readonly check: string;
  readonly pass: boolean;
  /** Passed only within margin. */
  readonly margin?: true;
}

const EMOJI = /[\uD83C-\uD83E][\uDC00-\uDFFF]|[☀-➿]/g;
const COUNTS = {
  emoji: (text: string) => text.match(EMOJI)?.length ?? 0,
  exclamations: (text: string) => text.split("!").length - 1,
  questions: (text: string) => text.split("?").length - 1,
  bullets: (text: string) => text.match(/^[ \t]*[-*] /gm)?.length ?? 0,
  paragraphs: (text: string) =>
    text.trim() === "" ? 0 : text.trim().split(/\n[ \t]*\n\s*/).length,
};

const banded = (name: string, limit: number, actual: number, over: number): Check => {
  const label = `limits ${name} <= ${limit}: ${actual}`;
  if (actual <= limit) return { check: label, pass: true };
  if (actual <= limit + over)
    return { check: `${label} (within margin)`, pass: true, margin: true };
  return { check: label, pass: false };
};

export const limitChecks = (limits: Limits | undefined, text: string): Array<Check> => {
  if (limits === undefined) return [];
  const { chars, ...counts } = limits;
  return [
    ...(chars === undefined ? [] : [banded("chars", chars, text.length, Math.floor(chars / 2))]),
    ...Object.entries(counts).flatMap(([name, limit]) =>
      limit === undefined
        ? []
        : [banded(name, limit, COUNTS[name as keyof typeof COUNTS](text), 1)],
    ),
  ];
};

export const sampleState = (checks: ReadonlyArray<Check>): State =>
  checks.some((check) => !check.pass)
    ? "fail"
    : checks.some((check) => check.margin === true)
      ? "margin"
      : "pass";

/**
 * A case's state from its finished samples' states. It fails without enough passes; it passes
 * within margin when a sample needed the margin, or a case with `margin` lost a sample.
 */
export const caseState = (
  states: ReadonlyArray<State>,
  margin: CaseMargin | undefined,
): State | undefined => {
  if (states.length === 0) return undefined;
  const passed = states.filter((state) => state !== "fail").length;
  const enough =
    margin === undefined
      ? passed > states.length / 2
      : passed >= Math.ceil((states.length * margin.passes) / margin.of);
  if (!enough) return "fail";
  const lostOne = margin !== undefined && passed < states.length;
  return lostOne || states.includes("margin") ? "margin" : "pass";
};
