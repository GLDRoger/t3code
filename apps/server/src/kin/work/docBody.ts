// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous section hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";
import { KinChatError, type KinDocOperation, type KinDocSection } from "@t3tools/contracts";
import { diffLines, FILE_HEADERS_ONLY, formatPatch, structuredPatch } from "diff";
import * as Schema from "effect/Schema";

/**
 * A doc's markdown as sections, and the operations agents edit it with. Pure: storage, authority
 * and provenance live in `docs.ts`. A section is a heading and the text under it, up to the next
 * heading of any level, so a parent's intro and its child change independently; `top` is the
 * text before the first heading.
 */

export const DOC_BODY_MAX = 200_000;
/** A doc this short comes back whole from `doc_read` and may be rewritten freely. */
const SHORT_DOC = 1_500;
/** Up to this, `doc_read` returns the body with its outline; past it, the outline only. */
export const WHOLE_DOC = 6_000;

export type Section = KinDocSection & { readonly text: string };

export type Operation =
  | {
      readonly op: "replace_section";
      readonly section: string;
      readonly hash: string;
      readonly text: string;
    }
  | { readonly op: "insert_after"; readonly section: string; readonly text: string }
  | { readonly op: "append"; readonly text: string }
  | { readonly op: "replace_phrase"; readonly find: string; readonly replace: string }
  | { readonly op: "retitle"; readonly title: string };

const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

const isChatError = Schema.is(KinChatError);
const conflict = (message: string) => new KinChatError({ reason: "conflict", message });
const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });

/** One line ending, and a final newline, so hashes and diffs don't move with the writer's OS. */
export const normalize = (body: string) => {
  const text = body.replace(/\r\n?/g, "\n").replace(/\s+$/, "");
  return text === "" ? "" : `${text}\n`;
};

const hashOf = (text: string) =>
  NodeCrypto.createHash("sha256").update(text).digest("hex").slice(0, 12);

const slug = (title: string) =>
  title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "") || "section";

/** Every section in order, `top` included even when empty, so it can be named in an edit. */
export const sectionsOf = (body: string): ReadonlyArray<Section> => {
  const lines = normalize(body).replace(/\n$/, "").split("\n");
  const starts: Array<{ readonly line: number; readonly level: number; readonly title: string }> =
    [];
  let fence: string | undefined;
  lines.forEach((line, index) => {
    const opened = FENCE.exec(line)?.[1];
    if (fence !== undefined) {
      if (opened !== undefined && opened[0] === fence[0] && opened.length >= fence.length)
        fence = undefined;
      return;
    }
    if (opened !== undefined) {
      fence = opened;
      return;
    }
    const heading = HEADING.exec(line);
    if (heading !== null)
      starts.push({ line: index, level: heading[1]!.length, title: (heading[2] ?? "").trim() });
  });
  const used = new Set(["top"]);
  const idFor = (title: string) => {
    const base = slug(title);
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    return id;
  };
  const cut = (from: number, to: number) => (from >= to ? "" : lines.slice(from, to).join("\n"));
  const top = cut(0, starts[0]?.line ?? lines.length);
  const section = (id: string, title: string, level: number, text: string): Section => ({
    id,
    title,
    level,
    chars: text.length,
    hash: hashOf(text),
    text,
  });
  return [
    section("top", "", 0, top.trim() === "" ? "" : top),
    ...starts.map((start, index) =>
      section(
        idFor(start.title),
        start.title,
        start.level,
        cut(start.line, starts[index + 1]?.line ?? lines.length),
      ),
    ),
  ];
};

/** What an agent and the contents sheet see: `top` only when it has text. */
export const outlineOf = (body: string): ReadonlyArray<KinDocSection> =>
  sectionsOf(body)
    .filter((section) => section.id !== "top" || section.text !== "")
    .map(({ text: _text, ...section }) => section);

const join = (sections: ReadonlyArray<{ readonly text: string }>) =>
  normalize(
    sections
      .map((section) => section.text)
      .filter((text) => text !== "")
      .join("\n"),
  );

const startsWithHeading = (text: string) => {
  const first = normalize(text).split("\n")[0] ?? "";
  return HEADING.test(first);
};

const named = (sections: ReadonlyArray<Section>, id: string) => {
  const found = sections.find((section) => section.id === id);
  if (found === undefined)
    throw invalid(
      `No section ${id.slice(0, 64)}. Sections now: ${sections
        .filter((section) => section.id !== "top" || section.text !== "")
        .map((section) => section.id)
        .join(", ")}.`,
    );
  return found;
};

const occurrences = (body: string, phrase: string) => {
  let count = 0;
  for (let at = body.indexOf(phrase); at !== -1; at = body.indexOf(phrase, at + phrase.length))
    count++;
  return count;
};

const SHOWN_TEXT = 4_000;
const shownText = (text: string) =>
  text.length <= SHOWN_TEXT
    ? text
    : `${text.slice(0, SHOWN_TEXT)}…[${text.length - SHOWN_TEXT} more chars]`;

/**
 * Applies `operations` to the current body in order, all or nothing. Every expected hash is
 * checked against the current text first: a section someone else changed is refused with its
 * text now, to redo the edit against.
 */
export const applyOperations = (
  body: string,
  title: string,
  operations: ReadonlyArray<Operation>,
):
  | {
      readonly _tag: "applied";
      readonly body: string;
      readonly title: string;
      readonly ops: ReadonlyArray<KinDocOperation>;
    }
  | { readonly _tag: "refused"; readonly error: KinChatError } => {
  try {
    const current = sectionsOf(body);
    for (const operation of operations) {
      if (operation.op !== "replace_section") continue;
      const section = named(current, operation.section);
      if (section.hash !== operation.hash)
        throw conflict(
          `Section ${section.id} changed since you read it, so nothing was changed. Its text now, hash ${section.hash}:\n${shownText(section.text)}\nRedo your edit against this text and hash.`,
        );
    }
    let sections = current;
    let nextTitle = title;
    const ops: Array<KinDocOperation> = [];
    for (const operation of operations) {
      switch (operation.op) {
        case "replace_section": {
          const section = named(sections, operation.section);
          // Text without a heading line keeps the section's heading.
          const heading =
            section.level === 0 ||
            startsWithHeading(operation.text) ||
            operation.text.trim() === "";
          const text = heading
            ? operation.text
            : `${section.text.split("\n")[0]}\n\n${operation.text.replace(/^\s+/, "")}`;
          sections = sectionsOf(
            join(
              sections.map((other) =>
                other === section ? { ...other, text: normalize(text).replace(/\n$/, "") } : other,
              ),
            ),
          );
          ops.push({ op: "replace_section", section: section.id });
          break;
        }
        case "insert_after": {
          const section = named(sections, operation.section);
          sections = sectionsOf(
            join(
              sections.flatMap((other) =>
                other === section
                  ? [other, { ...other, text: normalize(operation.text).replace(/\n$/, "") }]
                  : [other],
              ),
            ),
          );
          ops.push({ op: "insert_after", section: section.id });
          break;
        }
        case "append":
          sections = sectionsOf(
            join([...sections, { text: normalize(operation.text).replace(/\n$/, "") }]),
          );
          ops.push({ op: "append" });
          break;
        case "replace_phrase": {
          const text = join(sections);
          const count = occurrences(text, operation.find);
          if (count !== 1)
            throw invalid(
              count === 0
                ? "That phrase is not in the doc, so nothing was changed. Read the section and copy the phrase exactly."
                : `That phrase appears ${count} times, so nothing was changed. Make it longer so it matches once, or replace the section.`,
            );
          const at = text.indexOf(operation.find);
          const after = `${text.slice(0, at)}${operation.replace}${text.slice(at + operation.find.length)}`;
          const where = sections.find((section) => section.text.includes(operation.find));
          sections = sectionsOf(after);
          ops.push({ op: "replace_phrase", ...(where === undefined ? {} : { section: where.id }) });
          break;
        }
        case "retitle":
          nextTitle = operation.title;
          ops.push({ op: "retitle" });
          break;
      }
    }
    const next = join(sections);
    if (next.length > DOC_BODY_MAX)
      throw invalid(
        `A doc holds at most ${DOC_BODY_MAX} characters; this edit makes it ${next.length}.`,
      );
    return { _tag: "applied", body: next, title: nextTitle, ops };
  } catch (error) {
    if (isChatError(error)) return { _tag: "refused", error };
    throw error;
  }
};

/** Ids in `after` that are new or whose text changed, and ids `before` had that `after` lacks. */
export const changedSections = (before: string, after: string) => {
  const old = new Map(sectionsOf(before).map((section) => [section.id, section.hash]));
  const next = sectionsOf(after).filter((section) => section.id !== "top" || section.text !== "");
  const ids = new Set(next.map((section) => section.id));
  return {
    changed: next
      .filter((section) => old.get(section.id) !== section.hash)
      .map((section) => section.id),
    removed: [...old.keys()].filter(
      (id) => !ids.has(id) && (id !== "top" || sectionsOf(before)[0]!.text !== ""),
    ),
  };
};

const lineCount = (text: string) => (text === "" ? 0 : text.replace(/\n$/, "").split("\n").length);

/**
 * The server's line against whole-doc rewrites: under a third of the lines differing is an edit
 * sent as a rewrite. A short doc is exempt.
 */
export const rewriteRefusal = (before: string, after: string): KinChatError | undefined => {
  if (before.length < SHORT_DOC) return undefined;
  let differing = 0;
  for (const part of diffLines(before, after))
    if (part.added === true || part.removed === true) differing += part.count;
  const total = lineCount(before) + lineCount(after);
  if (total === 0 || differing * 3 >= total) return undefined;
  const { changed, removed } = changedSections(before, after);
  const ids = [...changed, ...removed];
  return invalid(
    ids.length === 0
      ? "Nothing differs from the current text. Nothing was changed."
      : `Only ${ids.length === 1 ? "section" : "sections"} ${ids.join(", ")} differ${ids.length === 1 ? "s" : ""}: use doc_edit for ${ids.length === 1 ? "it" : "them"}. Nothing was changed.`,
  );
};

/** One file's unified git patch, the shape T3's diff viewers parse; empty when equal. */
export const patchOf = (name: string, before: string, after: string) => {
  if (before === after) return { patch: "", additions: 0, deletions: 0 };
  const structured = structuredPatch(
    `a/${name}`,
    `b/${name}`,
    before,
    after,
    undefined,
    undefined,
    {
      context: 3,
    },
  );
  let additions = 0;
  let deletions = 0;
  for (const hunk of structured.hunks)
    for (const line of hunk.lines) {
      if (line.startsWith("+")) additions++;
      else if (line.startsWith("-")) deletions++;
    }
  return {
    patch: `diff --git a/${name} b/${name}\n${formatPatch(structured, FILE_HEADERS_ONLY)}`,
    additions,
    deletions,
  };
};
