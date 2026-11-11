import type { KinOrgId, MemoryTrust } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { isCheckoutPath, isItemPath } from "../memory/checkoutPaths.ts";
import { parseFrontMatter } from "../memory/frontMatter.ts";
import { QUOTE_MAX, QUOTE_MISSING, QUOTE_TOO_LONG, quoteRefusal } from "../memory/keeping.ts";
import { kinShapeFailure } from "../memory/lint.ts";
import type { MaterialEntry } from "./material.ts";

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
const rank = (trust: MemoryTrust) => ["external", "agent", "member", "owner"].indexOf(trust);
/** What a person stated stays theirs as said: a dream changes none of these on it. */
const STATED_FIELDS = [
  "title",
  "trust",
  "said_by",
  "source",
  "source_event",
  "quote",
  "invalid_at",
  "what",
  "due",
] as const;

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

  // Every item file the dream wrote, so a supersession can be judged by the item it points to.
  const written = new Map<
    string,
    { readonly source: string; readonly trust: MemoryTrust; readonly quote?: string | undefined }
  >();
  for (const [path, text] of changes)
    if (isItemPath(path)) {
      const parsed = yield* parseFrontMatter(input.orgId, path, text).pipe(Effect.option);
      if (parsed._tag === "Some")
        written.set(parsed.value.frontMatter.id, parsed.value.frontMatter);
    }

  for (const [path, text] of changes) {
    if (path === "rules.md") {
      failures.push("rules.md changed");
      continue;
    }
    if (path === "INDEX.md") {
      failures.push("INDEX.md is built by code");
      continue;
    }
    if (!isCheckoutPath(path) || kinShapeFailure(path) !== undefined) {
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
    const earlier = previous?._tag === "Some" ? previous.value.frontMatter : undefined;
    // What a teammate's chat left stays theirs as written, and only the owner clears an item.
    if (earlier?.shared_from !== undefined || fm.shared_from !== undefined)
      failures.push(`${path} came from a chat other people read and is not a dream's to change`);
    if (
      earlier?.shared_by?.person !== fm.shared_by?.person ||
      earlier?.shared_by?.at !== fm.shared_by?.at
    )
      failures.push(`${path} changes who let the team know it`);
    if (earlier !== undefined && (earlier.trust === "owner" || earlier.trust === "member")) {
      const refuse = (field: string) =>
        failures.push(`${path} holds what a person stated, so a dream may not change its ${field}`);
      if (previous?._tag === "Some" && previous.value.body !== parsed.success.body) refuse("body");
      for (const field of STATED_FIELDS) if (earlier[field] !== fm[field]) refuse(field);
      // Only an item tonight made from it, never above its trust and with its words, replaces it.
      if (earlier.superseded_by !== fm.superseded_by) {
        const next = fm.superseded_by === null ? undefined : written.get(fm.superseded_by);
        if (
          next === undefined ||
          next.source !== `memory:${path}` ||
          rank(next.trust) > rank(earlier.trust) ||
          next.quote !== earlier.quote
        )
          failures.push(
            `${path} may be replaced only by an item made from it, with its trust and quote`,
          );
      }
      if (
        earlier.status !== fm.status &&
        !(fm.status === "superseded" && earlier.superseded_by !== fm.superseded_by)
      )
        refuse("status");
      continue;
    }
    const kept =
      previous?._tag === "Some" &&
      previous.value.frontMatter.trust === fm.trust &&
      previous.value.frontMatter.said_by === fm.said_by &&
      previous.value.frontMatter.source === fm.source;
    if (kept) {
      if (earlier?.quote !== fm.quote) failures.push(`${path} changes its quote`);
      continue;
    }
    const author = material.get(fm.source);
    if (author === undefined) failures.push(`${path} source ${fm.source} is not in the material`);
    // A reminder was asked for, not stated: what is made from it is at most the agent's.
    else if (author.reminder === true && author.saidBy === fm.said_by) {
      if (rank(fm.trust) > Math.min(rank(author.trust), rank("agent")))
        failures.push(
          `${path} claims ${fm.trust} from a reminder; what a reminder says is at most agent`,
        );
    } else if (author.trust !== fm.trust || author.saidBy !== fm.said_by)
      failures.push(
        `${path} claims ${fm.trust} from ${fm.said_by}; the source was ${author.trust} from ${author.saidBy}`,
      );
    // As for a lead's write: what a person said holds their words from that message, and an
    // item folded from another carries that item's quote over, never a new one.
    if (author !== undefined && fm.kind !== "deferral") {
      const refusal =
        author.kind === "item"
          ? author.quote !== fm.quote
            ? `must keep the quote of ${fm.source} as it is`
            : fm.quote !== undefined && fm.quote.length > QUOTE_MAX
              ? QUOTE_TOO_LONG
              : undefined
          : fm.quote !== undefined
            ? quoteRefusal(fm.quote, author.text)
            : author.kind === "chat" && author.trust !== "agent"
              ? QUOTE_MISSING
              : undefined;
      if (refusal !== undefined) failures.push(`${path} quote: ${refusal}`);
    }
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
