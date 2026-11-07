import { MemoryItemFrontMatter, type KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { parse } from "yaml";

export class MemoryItemError extends Schema.TaggedError<MemoryItemError>()("MemoryItemError", {
  orgId: Schema.String,
  path: Schema.String,
  cause: Schema.Defect(),
}) {}

const decodeFrontMatter = Schema.decodeUnknownEffect(MemoryItemFrontMatter);

export const parseFrontMatter = Effect.fn("Memory.parseFrontMatter")(function* (
  orgId: KinOrgId,
  path: string,
  text: string,
) {
  const parts = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!parts) {
    return yield* new MemoryItemError({ orgId, path, cause: "Missing front matter delimiters" });
  }
  const value: unknown = yield* Effect.try({
    try: () => parse(parts[1] ?? "", { schema: "core", version: "1.2", uniqueKeys: true }),
    catch: (cause) => new MemoryItemError({ orgId, path, cause }),
  });
  const frontMatter = yield* decodeFrontMatter(value).pipe(
    Effect.mapError((cause) => new MemoryItemError({ orgId, path, cause })),
  );
  return { frontMatter, body: parts[2] ?? "" };
});
