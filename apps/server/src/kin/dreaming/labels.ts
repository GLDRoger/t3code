import type { KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { isItemPath } from "../memory/checkoutPaths.ts";
import { parseFrontMatter } from "../memory/frontMatter.ts";
import { isSensitive, mustBeSensitive, type StoredLabels } from "../memory/sensitivity.ts";

/** The item's text with its `sensitive` line set, leaving every other byte as the dream wrote it. */
const withLabel = (text: string, sensitive: boolean) => {
  const parts = /^((?:﻿)?---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$)[\s\S]*)$/.exec(text);
  if (parts === null) return text;
  const [, open = "", front = "", rest = ""] = parts;
  const line = `sensitive: ${sensitive}`;
  return `${open}${
    /^sensitive:.*$/m.test(front) ? front.replace(/^sensitive:.*$/m, line) : `${front}\n${line}`
  }${rest}`;
};

/**
 * Labels settled by code, not the model: a labelled item keeps its label, a merge takes the most
 * sensitive one, money or access text is sensitive, and an unlabelled item is sensitive.
 * `classified` holds the label of every item that had none anywhere, for `classify`.
 */
export const keepLabels = Effect.fn("DreamLabels.keep")(function* (input: {
  readonly orgId: KinOrgId;
  readonly base: ReadonlyMap<string, string>;
  readonly tree: ReadonlyMap<string, string>;
  readonly changes: ReadonlyMap<string, string>;
  readonly merges: ReadonlyArray<{ readonly into: string; readonly from: ReadonlyArray<string> }>;
  readonly labels: StoredLabels;
}) {
  const parse = (path: string, text: string) =>
    parseFrontMatter(input.orgId, path, text).pipe(Effect.option);
  const before = new Map<
    string,
    { readonly sensitive: boolean | undefined; readonly by: unknown }
  >();
  for (const [path, text] of input.base) {
    if (!isItemPath(path)) continue;
    const parsed = yield* parse(path, text);
    if (parsed._tag === "Some")
      before.set(parsed.value.frontMatter.id, {
        sensitive: parsed.value.frontMatter.sensitive,
        by: parsed.value.frontMatter.superseded_by,
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
  const classified = new Map<string, boolean>();
  for (const { path, text, frontMatter, body } of after) {
    const { id } = frontMatter;
    const content = [frontMatter.title, frontMatter.what ?? "", body, ...frontMatter.links].join(
      "\n",
    );
    const sensitive =
      labelBefore(id) === true ||
      input.labels.held.has(id) ||
      mustBeSensitive(content) ||
      [...(sources.get(id) ?? [])].some(wasSensitive) ||
      // A label the dream dropped comes back; one nobody ever set reads as the owner's alone.
      (frontMatter.sensitive ?? labelBefore(id) ?? true);
    if (before.has(id) && labelBefore(id) === undefined) classified.set(id, sensitive);
    // Only files the dream touched are rewritten; the rest keep their label in the database.
    if (changes.has(path) && sensitive !== frontMatter.sensitive)
      changes.set(path, withLabel(text, sensitive));
  }
  return { changes, classified };
});
