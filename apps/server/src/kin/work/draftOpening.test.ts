import { assert, describe, it } from "@effect/vitest";
import { kinDraftOpeningOf } from "@t3tools/contracts";

import { DRAFT_TEXT_MAX, draftOnCard, draftOpening, isLongDraft } from "./draftOpening.ts";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const clusters = (text: string) => Array.from(graphemes.segment(text), (part) => part.segment);
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const family = "👨‍👩‍👧‍👦";
const rows: ReadonlyArray<readonly [string, string]> = [
  ["joined emoji, no spaces", family.repeat(40)],
  ["flags, no spaces", "🇮🇳🇬🇧".repeat(40)],
  ["combining accents", "é".repeat(80)],
  ["Devanagari", "क्षत्रिय नमस्ते ".repeat(12)],
  ["a URL first", `https://example.com/${"a".repeat(120)} then words`],
  ["a number first", `${"9".repeat(90)} rupees in all`],
  ["sentences", "Dear Meera. The proposal follows. ".repeat(8)],
  ["Japanese sentences", "見積もりを送ります。ご確認ください。".repeat(8)],
  ["emoji between words", `Hello ${family} there `.repeat(12)],
];

describe("draftOpening", () => {
  for (const max of [7, 20, 33]) {
    for (const [name, text] of rows) {
      it(`${name}, at most ${max}`, () => {
        const opening = draftOpening(text, max);
        const cut = opening.endsWith("…") && !text.includes("…");
        const kept = cut ? opening.slice(0, -1) : opening;
        assert.isAtMost(opening.length, max);
        assert.isAbove(kept.length, 0);
        assert.isTrue(text.trim().startsWith(kept));
        assert.notMatch(opening, LONE_SURROGATE);
        // It ends where a character ends, unless one character alone is longer than the opening.
        const head = clusters(kept);
        if (clusters(text.trim())[0]!.length < max)
          assert.deepStrictEqual(clusters(text.trim()).slice(0, head.length), head);
        // Only a first word too long for the opening is cut inside, and it says so.
        if (!cut)
          assert.isTrue(
            /^(\s|$)/.test(text.trim().slice(kept.length)) || /[.!?。！？]$/.test(kept),
          );
      });
    }
  }

  it("cuts a first word longer than the opening with a visible …", () => {
    assert.strictEqual(draftOpening(`${"x".repeat(30)} more`, 10), `${"x".repeat(9)}…`);
    assert.strictEqual(draftOpening(family.repeat(5), 12), `${family}…`);
    assert.strictEqual(draftOpening("short", 10), "short");
  });
});

describe("isLongDraft", () => {
  it("is one rule: the trimmed text over the limit, or a card already holding an opening", () => {
    const at = "a".repeat(DRAFT_TEXT_MAX);
    assert.isFalse(isLongDraft(at));
    assert.isFalse(isLongDraft(`  ${at}\n\n`));
    assert.isTrue(isLongDraft(`${at}b`));
    assert.isTrue(isLongDraft("short", { whole: { version: 2, chars: 1801 } }));
    assert.isFalse(isLongDraft("short", {}));
  });

  it("a long card's text ends with the line an older client shows, and a current one strips", () => {
    const body = "Dear Meera. ".repeat(200);
    const card = draftOnCard(body, 3, "D-4");
    assert.deepStrictEqual(card.whole, { version: 3, chars: body.trim().length });
    assert.isTrue(
      card.text.endsWith("\n\nThis is only the opening. Open D-4 to read the whole draft."),
    );
    assert.strictEqual(kinDraftOpeningOf(card.text, "D-4"), draftOpening(body));
    assert.deepStrictEqual(draftOnCard("Dear Meera.", 1, "D-4"), { text: "Dear Meera." });
  });
});
