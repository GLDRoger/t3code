// @effect-diagnostics-next-line nodeBuiltinImport:off -- reads Kin's own sources, synchronously.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- reads Kin's own sources, synchronously.
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";

/**
 * Every SQL read of an amount in Kin, or fragment that names one, either counts by the one rule (`countedEntry`,
 * `countedPayment` in `recordRows.ts`) or is one of the reads of a single entry's own money below.
 * A new query that adds up or exports amounts fails here until it uses the rule.
 */

const KIN = NodePath.resolve(import.meta.dirname, "..");
// Reads of one entry's own amount or payments, or a screen's list that shows each row's state.
const OWN_READS: Readonly<Record<string, number>> = {
  // The one entry an email attaches, for the card's label.
  "connections/Sending.ts": 1,
  // A receipt's payment; one entry's payments on its document.
  "gendocs/facts.ts": 2,
  // A receipt's payment; the receipts list a screen shows, void ones marked.
  "gendocs/receipts.ts": 2,
  // A receipt already made for this advance: one entry's own amount matched, nothing summed.
  "gendocs/receiptProposals.ts": 1,
  // The columns every read selects, with an entry's own paid and withheld; one entry's payments.
  "work/recordRows.ts": 2,
  // Money's suggestions: the entries its figures leave out, listed one by one, nothing summed.
  "work/moneyViews.ts": 1,
  // One entry's payments, read to check a retry and to void one; a totals query's has-amount filter.
  "work/KinRecords.ts": 3,
  // The columns each pulse sense selects; every sense that reads money applies the rule itself.
  "pulse/senses/shared.ts": 1,
  // Quiet projects: a project's last move, read whole, no amount of it used.
  "pulse/senses/projects.ts": 1,
  // Download everything: each entry's own amount and payments, copied out as they are, never summed.
  "work/exportBundle.ts": 2,
  // One settlement's parts, read to check a retry.
  "work/leadMoney.ts": 1,
  // A new entry's repeats: entries of its exact amount, compared one by one, nothing summed.
  "work/leadWork.ts": 1,
  // A statement's own rows, and the entries and recorded payments one row may match.
  "work/statements/bankList.ts": 1,
  "work/statements/statementReview.ts": 4,
  // Whether a figure in a message is the sum on some entry or payment its reader can't see.
  "work/teamView.ts": 3,
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

/** SQL comments and string literals' contents, so neither a rule's name nor a word in them counts. */
const stripped = (body: string) =>
  body
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, "''");

// Limits: SQL outside a `sql`/`db` template (plain strings, `sql.unsafe`) and a fragment imported from
// another file are not seen; a rule interpolated but not applied (say inside a CASE) still passes.
/** Each `sql` or `db` template in `text`, whole or a fragment, that reads an amount without the rule. */
const uncounted = (text: string) => {
  const found: Array<string> = [];
  for (const match of text.matchAll(/\b(?:sql|db)(?:<[^`]*?>)?`/g)) {
    const { body: raw } = templateAt(text, match.index + match[0].length - 1);
    const body = stripped(raw);
    const reads =
      /\bamount_minor\b/i.test(body) ||
      (/\bselect\s+(?:\w+\.)?\*/i.test(body) && /\bkin_record(?:s|_payments)\b/i.test(body));
    if (!reads) continue;
    if (/^\s*(?:insert|update|delete)\b/i.test(body)) continue;
    if (/\$\{\s*counted(?:Entry|Payment)\(/.test(body)) continue;
    found.push(raw.trim().slice(0, 120));
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

  it("sees a read however it is written", () => {
    const tick = "`";
    const read = (body: string, tag = "sql") => uncounted(`${tag}${tick}${body}${tick}`).length;
    assert.deepStrictEqual(
      [
        read("select sum(amount_minor) from kin_records r"),
        read("SELECT SUM(amount_minor) FROM kin_records r", "db"),
        read("SELECT SUM(amount_minor) FROM kin_records r -- ${countedEntry(sql)}"),
        read("SELECT * FROM kin_records r WHERE org_id = ${orgId}"),
        read("r.amount_minor > 0"),
        read("SELECT SUM(amount_minor) FROM kin_records r WHERE ${countedEntry(sql)}"),
        read("UPDATE kin_records SET amount_minor = ${minor}"),
        read("SELECT title FROM kin_records r WHERE note = 'amount_minor'"),
      ],
      [1, 1, 1, 1, 1, 0, 0, 0],
    );
  });
});
