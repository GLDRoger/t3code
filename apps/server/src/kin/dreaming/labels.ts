import type { KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { parseDocument } from "yaml";

import { isItemPath } from "../memory/checkoutPaths.ts";
import { FRONT_MATTER_YAML, parseFrontMatter } from "../memory/frontMatter.ts";
import {
  contentOf,
  fingerprint,
  isSensitive,
  mustBeSensitive,
  type StoredLabels,
} from "../memory/sensitivity.ts";

/**
 * The item's text with `sensitive` set. An ordinary file keeps every other byte; one whose label
 * isn't a plain top-level line (quoted key, indented or flow mapping) is re-rendered by the parser.
 */
export const withLabel = (text: string, sensitive: boolean) => {
  const parts = /^((?:\uFEFF)?---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$)[\s\S]*)$/.exec(text);
  if (parts === null) return text;
  const [, open = "", front = "", rest = ""] = parts;
  const doc = parseDocument(front, FRONT_MATTER_YAML);
  if (doc.errors.length > 0) return text;
  const want = JSON.stringify({ ...doc.toJS(), sensitive });
  const line = `sensitive: ${sensitive}`;
  const plain = /^sensitive:.*$/m.test(front)
    ? front.replace(/^sensitive:.*$/m, line)
    : `${front}\n${line}`;
  const check = parseDocument(plain, FRONT_MATTER_YAML);
  if (check.errors.length === 0 && JSON.stringify(check.toJS()) === want)
    return `${open}${plain}${rest}`;
  doc.set("sensitive", sensitive);
  return `${open}${doc.toString().replace(/\r?\n$/, "")}${rest}`;
};

/**
 * Labels settled by code, not the model: kept, the most sensitive through a merge, sensitive for
 * money, access or no label. `classified` labels what had none, for `classify`; `suggested` is the
 * new words of each item the dream made or reworded for the team, which only the owner confirms.
 */
export const keepLabels = Effect.fn("DreamLabels.keep")(function* (input: {
  readonly orgId: KinOrgId;
  readonly base: ReadonlyMap<string, string>;
  readonly tree: ReadonlyMap<string, string>;
  readonly changes: ReadonlyMap<string, string>;
  readonly merges: ReadonlyArray<{ readonly into: string; readonly from: ReadonlyArray<string> }>;
  readonly labels: Pick<StoredLabels, "held" | "classified">;
}) {
  const parse = (path: string, text: string) =>
    parseFrontMatter(input.orgId, path, text).pipe(Effect.option);
  const before = new Map<
    string,
    { readonly sensitive: boolean | undefined; readonly by: unknown; readonly content: string }
  >();
  for (const [path, text] of input.base) {
    if (!isItemPath(path)) continue;
    const parsed = yield* parse(path, text);
    if (parsed._tag === "Some")
      before.set(parsed.value.frontMatter.id, {
        sensitive: parsed.value.frontMatter.sensitive,
        by: parsed.value.frontMatter.superseded_by,
        content: fingerprint({ head: parsed.value.frontMatter, body: parsed.value.body }),
      });
  }
  /** What it was before tonight; undefined when nothing had labelled it yet. */
  const labelBefore = (id: string) => before.get(id)?.sensitive ?? input.labels.classified.get(id);
  const wasSensitive = (id: string) => {
    const item = before.get(id);
    return item !== undefined && isSensitive({ id, sensitive: item.sensitive }, input.labels);
  };
  const after = [];
  for (const [path, text] of input.tree) {
    if (!isItemPath(path)) continue;
    const parsed = yield* parse(path, text);
    if (parsed._tag === "Some") after.push({ path, text, ...parsed.value });
  }
  // What went into each item: what the dream reported, and every item it newly pointed there.
  const sources = new Map<string, Set<string>>();
  const into = (target: string, from: string) =>
    sources.set(target, (sources.get(target) ?? new Set()).add(from));
  for (const merge of input.merges) for (const from of merge.from) into(merge.into, from);
  for (const { frontMatter } of after)
    if (
      frontMatter.superseded_by !== null &&
      before.get(frontMatter.id)?.by !== frontMatter.superseded_by
    )
      into(frontMatter.superseded_by, frontMatter.id);

  const changes = new Map(input.changes);
  const classified = new Map<string, { sensitive: boolean; content: string }>();
  const suggested = new Map<string, string>();
  for (const { path, text, frontMatter, body } of after) {
    const { id } = frontMatter;
    // The words a shared turn would be given, the same projection an authorisation covers.
    const content = contentOf({ head: frontMatter, body });
    const sensitive =
      labelBefore(id) === true ||
      input.labels.held.has(id) ||
      // The quote is stored beside those words, and money or access in it is as private.
      mustBeSensitive(`${content}\n${frontMatter.quote ?? ""}`) ||
      [...(sources.get(id) ?? [])].some(wasSensitive) ||
      // A label the dream dropped comes back; one nobody ever set reads as the owner's alone.
      (frontMatter.sensitive ?? labelBefore(id) ?? true);
    const words = fingerprint({ head: frontMatter, body });
    if (before.has(id) && labelBefore(id) === undefined)
      classified.set(id, { sensitive, content: words });
    if (changes.has(path) && !sensitive && before.get(id)?.content !== words)
      suggested.set(id, words);
    // Only files the dream touched are rewritten; the rest keep their label in the database.
    if (changes.has(path) && sensitive !== frontMatter.sensitive)
      changes.set(path, withLabel(text, sensitive));
  }
  return { changes, classified, suggested };
});
