// @effect-diagnostics-next-line nodeBuiltinImport:off -- reads Kin's own sources, synchronously.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- reads Kin's own sources, synchronously.
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";

/**
 * Every SQL read of an amount in Kin either counts by the one rule (`countedEntry`,
 * `countedPayment` in `recordRows.ts`) or is one of the reads of a single entry's own money below.
 * A new query that adds up or exports amounts fails here until it uses the rule.
 */

const KIN = NodePath.resolve(import.meta.dirname, "..");
// Reads of one entry's own amount or payments, or a screen's list that shows each row's state.
const OWN_READS: Readonly<Record<string, number>> = {
  // A receipt's payment; one entry's payments on its document.
  "gendocs/facts.ts": 2,
  // A receipt's payment; the receipts list a screen shows, void ones marked.
  "gendocs/receipts.ts": 2,
  // The columns every read selects, with an entry's own paid and withheld; one entry's payments.
  "work/recordRows.ts": 2,
  // One entry's payments, read to check a retry and to void one.
  "work/KinRecords.ts": 2,
  // A statement's own rows, and the entries one row may match, each shown with its state.
  "work/statements/bankList.ts": 1,
  "work/statements/statementReview.ts": 3,
};

const sourcesUnder = (dir: string): ReadonlyArray<string> =>
  NodeFS.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = NodePath.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "migrations" ? [] : sourcesUnder(full);
    return /\.ts$/.test(entry.name) && !/\.test(kit)?\.ts$|\.testkit\.ts$/.test(entry.name)
      ? [full]
      : [];
  });

/** The text of the template literal opening at `start`, interpolations included; and its end. */
const templateAt = (text: string, start: number): { body: string; end: number } => {
  let body = "";
  let at = start + 1;
  while (at < text.length) {
    const char = text[at]!;
    if (char === "\\") {
      body += text.slice(at, at + 2);
      at += 2;
    } else if (char === "`") return { body, end: at };
    else if (char === "$" && text[at + 1] === "{") {
      let depth = 1;
      let inner = at + 2;
      while (depth > 0 && inner < text.length) {
        const one = text[inner]!;
        if (one === "`") {
          inner = templateAt(text, inner).end + 1;
          continue;
        }
        if (one === "{") depth += 1;
        else if (one === "}") depth -= 1;
        inner += 1;
      }
      body += text.slice(at, inner);
      at = inner;
    } else {
      body += char;
      at += 1;
    }
  }
  return { body, end: at };
};

/** Each `sql` template in `text` that reads an amount without the rule. */
const uncounted = (text: string) => {
  const found: Array<string> = [];
  for (const match of text.matchAll(/\bsql(?:<[^`]*?>)?`/g)) {
    const { body } = templateAt(text, match.index + match[0].length - 1);
    if (!body.includes("amount_minor") || !/\bSELECT\b/.test(body)) continue;
    if (/^\s*(?:INSERT|UPDATE|DELETE)\b/.test(body)) continue;
    if (/\bcounted(?:Entry|Payment)\(/.test(body)) continue;
    found.push(body.trim().slice(0, 120));
  }
  return found;
};

describe("what a figure counts", () => {
  it("is one rule every amount query uses, besides one entry's own reads", () => {
    const seen: Record<string, ReadonlyArray<string>> = {};
    for (const file of sourcesUnder(KIN)) {
      const reads = uncounted(NodeFS.readFileSync(file, "utf8"));
      if (reads.length > 0) seen[NodePath.relative(KIN, file)] = reads;
    }
    const counts = Object.fromEntries(
      Object.entries(seen).map(([file, reads]) => [file, reads.length]),
    );
    const expected = Object.fromEntries(Object.entries(OWN_READS).filter(([, n]) => n > 0));
    assert.deepStrictEqual(counts, expected, JSON.stringify(seen, null, 2));
  });
});
