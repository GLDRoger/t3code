import type { KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { parseFrontMatter } from "../memory/frontMatter.ts";
import { itemFolders, type MaterialEntry } from "./material.ts";

const Sources = Schema.Array(Schema.String).check(Schema.isMinLength(1));
const Id = Schema.String.check(Schema.isNonEmpty());

/** The dream's account of its work. Written by the model; trusted only after `checkDream`. */
export const DreamJson = Schema.Struct({
  changes: Schema.Array(Schema.Struct({ path: Schema.String, sources: Sources })),
  merges: Schema.Array(
    Schema.Struct({
      into: Id,
      from: Schema.Array(Id).check(Schema.isMinLength(1)),
      sources: Sources,
    }),
  ),
  supersessions: Schema.Array(
    Schema.Struct({
      id: Id,
      invalid_at: Schema.NullOr(Schema.String),
      superseded_by: Schema.NullOr(Id),
      sources: Sources,
    }),
  ),
  contradictions: Schema.Array(
    Schema.Struct({
      items: Schema.Array(Id).check(Schema.isMinLength(1)),
      summary: Schema.String,
      sources: Sources,
      resolution: Schema.optional(Schema.String),
      question: Schema.optional(Schema.String),
    }),
  ),
});
export type DreamJson = typeof DreamJson.Type;
const decodeDream = Schema.decodeUnknownEffect(Schema.fromJsonString(DreamJson));

const isItemPath = (path: string) =>
  path.endsWith(".md") && itemFolders.some((folder) => path.startsWith(`${folder}/`));
const isJournalPath = (path: string) => path.startsWith("journal/") && path.endsWith(".md");
/** What a dream checkout holds. Anything else at HEAD, such as `.mcp.json` or `.claude/`, could configure the provider. */
export const isDreamPath = (path: string) =>
  path === "rules.md" || path === "INDEX.md" || isItemPath(path) || isJournalPath(path);

/**
 * The code checks a dream must pass before anything is committed. `tree` is what the
 * model left in its checkout; `special` lists paths that were not regular files.
 */
export const checkDream = Effect.fn("DreamRunner.check")(function* (input: {
  readonly orgId: KinOrgId;
  readonly base: ReadonlyMap<string, string>;
  readonly tree: ReadonlyMap<string, string>;
  readonly special: ReadonlyArray<string>;
  readonly dreamJson: string | undefined;
  readonly material: ReadonlyArray<MaterialEntry>;
  readonly requireResolutions: boolean;
}) {
  const failures: Array<string> = [];
  const changes = new Map<string, string>();
  for (const path of input.special) failures.push(`${path} is not a regular file`);
  for (const path of input.base.keys())
    if (!input.tree.has(path)) failures.push(`${path} was deleted`);
  for (const [path, text] of input.tree) if (input.base.get(path) !== text) changes.set(path, text);

  const dream =
    input.dreamJson === undefined
      ? undefined
      : yield* decodeDream(input.dreamJson).pipe(Effect.option);
  if (dream === undefined || dream._tag === "None")
    failures.push("dream.json is missing or invalid");
  const report = dream?._tag === "Some" ? dream.value : undefined;
  const material = new Map(input.material.map((entry) => [entry.ref, entry]));
  const listed = new Set(report?.changes.map((change) => change.path));

  for (const [path, text] of changes) {
    if (path === "rules.md") {
      failures.push("rules.md changed");
      continue;
    }
    if (path === "INDEX.md") {
      failures.push("INDEX.md is built by code");
      continue;
    }
    if (!isItemPath(path) && !isJournalPath(path)) {
      failures.push(`${path} is outside item files and journal/`);
      continue;
    }
    if (report !== undefined && !listed.has(path))
      failures.push(`${path} is not listed in dream.json`);
    if (!isItemPath(path)) continue;
    const parsed = yield* parseFrontMatter(input.orgId, path, text).pipe(Effect.result);
    if (parsed._tag === "Failure") {
      failures.push(`${path} does not parse: ${parsed.failure.reason}`);
      continue;
    }
    const fm = parsed.success.frontMatter;
    const folder = fm.kind === "person" ? "people" : `${fm.kind}s`;
    if (!path.startsWith(`${folder}/`))
      failures.push(`${path} kind ${fm.kind} is in the wrong folder`);
    const before = input.base.get(path);
    const previous =
      before === undefined
        ? undefined
        : yield* parseFrontMatter(input.orgId, path, before).pipe(Effect.option);
    const kept =
      previous?._tag === "Some" &&
      previous.value.frontMatter.trust === fm.trust &&
      previous.value.frontMatter.said_by === fm.said_by &&
      previous.value.frontMatter.source === fm.source;
    if (kept) continue;
    const author = material.get(fm.source);
    if (author === undefined) failures.push(`${path} source ${fm.source} is not in the material`);
    else if (author.trust !== fm.trust || author.saidBy !== fm.said_by)
      failures.push(
        `${path} claims ${fm.trust} from ${fm.said_by}; the source was ${author.trust} from ${author.saidBy}`,
      );
  }

  if (report !== undefined) {
    const refs = [
      ...report.changes.flatMap((entry) => entry.sources),
      ...report.merges.flatMap((entry) => entry.sources),
      ...report.supersessions.flatMap((entry) => entry.sources),
      ...report.contradictions.flatMap((entry) => entry.sources),
    ];
    for (const ref of new Set(refs))
      if (!material.has(ref)) failures.push(`source ${ref} is not in the material`);
    if (input.requireResolutions)
      for (const [index, contradiction] of report.contradictions.entries())
        if (!contradiction.resolution && !contradiction.question)
          failures.push(`contradiction ${index + 1} has no resolution or question`);
  }
  return { failures, changes, dream: report };
});
