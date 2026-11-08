import { MemoryItemFrontMatter, type KinOrgId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { defaultReviewBy } from "./freshness.ts";
import { isSeq, parseDocument } from "yaml";

export class MemoryItemError extends Schema.TaggedError<MemoryItemError>()("MemoryItemError", {
  orgId: Schema.String,
  path: Schema.String,
  reason: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Malformed memory item: ${this.reason}`;
  }
}

export const memoryDateMillis = (value: string | null) => {
  if (
    value === null ||
    !/^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/.test(
      value,
    )
  )
    return NaN;
  const date = value.slice(0, 10);
  const midnight = Date.parse(date);
  if (
    !Number.isFinite(midnight) ||
    DateTime.formatIso(DateTime.makeUnsafe(midnight)).slice(0, 10) !== date
  )
    return NaN;
  return Date.parse(value);
};

const decodeFrontMatter = Schema.decodeUnknownEffect(MemoryItemFrontMatter);
const decodeStaged = Schema.decodeUnknownEffect(
  Schema.Struct({
    ...MemoryItemFrontMatter.fields,
    review_by: Schema.optional(MemoryItemFrontMatter.fields.review_by),
  }),
);

// Parsing runs per blob under Memory.load; avoid creating a span for every item.
export const parseFrontMatter = Effect.fnUntraced(function* (
  orgId: KinOrgId,
  path: string,
  text: string,
  staged = false,
) {
  const parts = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!parts) {
    return yield* new MemoryItemError({ orgId, path, reason: "Missing front matter delimiters" });
  }
  const value: unknown = yield* Effect.try({
    try: () => {
      const doc = parseDocument(parts[1] ?? "", {
        schema: "core",
        version: "1.2",
        uniqueKeys: true,
        resolveKnownTags: false,
        keepSourceTokens: true,
      });
      const problem = doc.errors[0] ?? doc.warnings[0];
      if (problem) {
        const links = doc.get("links", true);
        const source = isSeq(links) ? links.srcToken : undefined;
        const commentedClosingBracket =
          source?.type === "flow-collection" &&
          !source.end.some((token) => token.type === "flow-seq-end") &&
          source.items.some(
            (item) =>
              item.value?.type === "scalar" &&
              item.value.end?.some(
                (token) => token.type === "comment" && token.source.includes("]"),
              ),
          );
        throw new Error(
          problem.code === "BAD_INDENT" && commentedClosingBracket
            ? "Malformed YAML; links containing # must be quoted"
            : `Malformed YAML: ${problem.message}`,
          { cause: problem },
        );
      }
      return doc.toJS();
    },
    catch: (cause) =>
      new MemoryItemError({
        orgId,
        path,
        reason: staged
          ? "Malformed YAML front matter"
          : cause instanceof Error
            ? cause.message
            : "Malformed YAML",
        ...(staged ? {} : { cause }),
      }),
  });
  const decoded = yield* (staged ? decodeStaged(value) : decodeFrontMatter(value)).pipe(
    Effect.mapError(
      (cause) => new MemoryItemError({ orgId, path, reason: "Invalid front matter schema", cause }),
    ),
  );
  for (const field of ["recorded_at", "valid_from", "invalid_at", "review_by", "due"] as const) {
    const value = decoded[field];
    if (value !== null && value !== undefined && !Number.isFinite(memoryDateMillis(value))) {
      return yield* new MemoryItemError({
        orgId,
        path,
        reason: `Invalid ${field}; date-times require an explicit offset`,
      });
    }
  }
  const frontMatter = {
    ...decoded,
    review_by: defaultReviewBy(
      {
        kind: decoded.kind,
        due: decoded.due,
        ...(decoded.review_by === undefined ? {} : { review_by: decoded.review_by }),
      },
      Date.parse(decoded.recorded_at),
    ),
  };
  return { frontMatter, body: parts[2] ?? "" };
});
