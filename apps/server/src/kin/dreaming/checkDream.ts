import type { KinOrgId, MemoryTrust } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { isCheckoutPath, isItemPath } from "../memory/checkoutPaths.ts";
import { changedKeys, parseFrontMatter } from "../memory/frontMatter.ts";
import { QUOTE_MISSING, quoteRefusal } from "../memory/keeping.ts";
import { kinShapeFailure } from "../memory/lint.ts";
import { withLabel } from "./labels.ts";
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
/**
 * The code checks a dream must pass before anything is committed. `base` is the checkout as the
 * model was shown it, `stored` the same files as they are on the branch, never shown to it;
 * `tree` is what the model left in its checkout; `special` lists paths that were not regular
 * files. `changes` is what to write, and `committed` every file as the branch will hold it.
 */
export const checkDream = Effect.fn("DreamRunner.check")(function* (input: {
  readonly orgId: KinOrgId;
  readonly base: ReadonlyMap<string, string>;
  readonly stored: ReadonlyMap<string, string>;
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

  const ids = new Map<string, string>();
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
    ids.set(path, fm.id);
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
    // What a person stated stays exactly as stored until a person changes it. The dream may
    // only label it, and `keepLabels` decides that label; its own copy is never written back.
    if (earlier !== undefined && (earlier.trust === "owner" || earlier.trust === "member")) {
      const changed = changedKeys(earlier, fm).filter((key) => key !== "sensitive");
      if (previous?._tag === "Some" && previous.value.body !== parsed.success.body)
        changed.push("body");
      for (const field of changed)
        failures.push(`${path} holds what a person stated, so a dream may not change its ${field}`);
      const stored = input.stored.get(path);
      if (changed.length > 0 || stored === undefined) continue;
      if (fm.sensitive === undefined || fm.sensitive === earlier.sensitive) changes.delete(path);
      else changes.set(path, withLabel(stored, fm.sensitive));
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
    if (author === undefined) {
      failures.push(`${path} source ${fm.source} is not in the material`);
      continue;
    }
    // What a dream makes from memory is its own conclusion, whoever said the item it cites.
    if (author.kind === "item") {
      if (
        author.saidBy !== fm.said_by ||
        rank(fm.trust) > Math.min(rank(author.trust), rank("agent"))
      )
        failures.push(
          `${path} claims ${fm.trust} from ${fm.source}; what is made from a memory item is at most agent`,
        );
      if (fm.quote !== undefined)
        failures.push(
          `${path} quote: an item made from a memory item is the agent's own and carries no quote`,
        );
      continue;
    }
    if (author.trust !== fm.trust || author.saidBy !== fm.said_by)
      failures.push(
        `${path} claims ${fm.trust} from ${fm.said_by}; the source was ${author.trust} from ${author.saidBy}`,
      );
    // As for an agent's write: what a person said holds their words from that message.
    if (fm.kind !== "deferral") {
      const refusal =
        fm.quote !== undefined
          ? quoteRefusal(fm.quote, author.text)
          : author.kind === "chat" && author.trust !== "agent"
            ? QUOTE_MISSING
            : undefined;
      if (refusal !== undefined) failures.push(`${path} quote: ${refusal}`);
    }
  }

  // Two files with one id leave neither readable by it, so a new file can't take an item's id.
  const holders = new Map<string, string>();
  for (const [path, text] of input.tree) {
    if (ids.has(path) || !isItemPath(path)) continue;
    const item = yield* parseFrontMatter(input.orgId, path, text).pipe(Effect.option);
    if (item._tag === "Some") holders.set(item.value.frontMatter.id, path);
  }
  for (const [path, id] of ids) {
    const holder = holders.get(id);
    const before = input.base.get(path);
    const earlier =
      before === undefined
        ? undefined
        : yield* parseFrontMatter(input.orgId, path, before).pipe(Effect.option);
    const kept = earlier?._tag === "Some" && earlier.value.frontMatter.id === id;
    if (holder !== undefined && !kept) failures.push(`${path} takes the id of ${holder}`);
    else if (holder === undefined) holders.set(id, path);
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
  const committed = new Map(
    [...input.tree.keys()].map((path) => [
      path,
      changes.get(path) ?? input.stored.get(path) ?? input.tree.get(path)!,
    ]),
  );
  return { failures, changes, committed, dream: report };
});
