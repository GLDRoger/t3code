import { MemoryItemFrontMatter, type KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { parseDocument } from "yaml";

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

export const memoryDateMillis = (value: string | null) =>
  value !== null && /^\d{4}-\d{2}-\d{2}(?:T.*(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)
    ? Date.parse(value)
    : NaN;

const decodeFrontMatter = Schema.decodeUnknownEffect(MemoryItemFrontMatter);

// Parsing runs per blob under Memory.load; avoid creating a span for every item.
export const parseFrontMatter = Effect.fnUntraced(function* (
  orgId: KinOrgId,
  path: string,
  text: string,
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
      });
      const problem = doc.errors[0] ?? doc.warnings[0];
      if (problem) throw problem;
      return doc.toJS();
    },
    catch: (cause) =>
      new MemoryItemError({
        orgId,
        path,
        reason: "Malformed YAML; links containing # must be quoted",
        cause,
      }),
  });
  const frontMatter = yield* decodeFrontMatter(value).pipe(
    Effect.mapError(
      (cause) => new MemoryItemError({ orgId, path, reason: "Invalid front matter schema", cause }),
    ),
  );
  for (const field of ["recorded_at", "valid_from", "invalid_at", "review_by", "due"] as const) {
    const value = frontMatter[field];
    if (value !== null && !Number.isFinite(memoryDateMillis(value))) {
      return yield* new MemoryItemError({
        orgId,
        path,
        reason: `Invalid ${field}; date-times require an explicit offset`,
      });
    }
  }
  return { frontMatter, body: parts[2] ?? "" };
});
