import { expect, it } from "@effect/vitest";
import {
  KIN_MONEY_SECTION,
  KIN_REPLY_BUBBLES_MAX,
  kinPageGist,
  kinPageShape,
  kinPageWithLines,
  kinPlainBody,
  kinReplyBubbles,
} from "./kinPage.ts";

const figure = "```kin_visual This week\nf_test000001\n```";

it("treats a figure as a page and uses its title when there is no takeaway", () => {
  expect(kinPageShape(figure)).toBe("page");
  expect(kinPageGist(figure)).toBe("This week");
  expect(kinPageGist(`Two tasks are late.\n\n${figure}`)).toBe("Two tasks are late.");
});

it("removes top-level figures but leaves an example inside a longer fence", () => {
  const example = `\`\`\`\`md\n${figure}\n\`\`\`\``;
  expect(kinPlainBody(`${figure}\n\n${example}`)).toBe(example);
});

it.each([
  [
    "into its own Money section, however it is headed",
    "## Needs you\n- A card waits.\n\nCash:\n- Nothing new.\n\n## Coming up\n- A call.",
    "## Needs you\n- A card waits.\n\nCash:\n- Nothing new.\n- Kin's line.\n\n## Coming up\n- A call.",
  ],
  [
    "as a section after Needs you when it has none",
    "## Needs you\n- A card waits.\n\n## Clients\n- Quiet.",
    "## Needs you\n- A card waits.\n\n## Money\n\n- Kin's line.\n\n## Clients\n- Quiet.",
  ],
  [
    "first when it has neither, after its greeting",
    "Good morning, Rhea.\n\n## Clients\n- Quiet.",
    "Good morning, Rhea.\n\n## Money\n\n- Kin's line.\n\n## Clients\n- Quiet.",
  ],
  [
    "never into a heading inside a code block",
    "## Needs you\n- A card waits.\n\n```md\n## Money\n```",
    "## Needs you\n- A card waits.\n\n```md\n## Money\n```\n\n## Money\n\n- Kin's line.",
  ],
])("puts Kin's own lines in a page %s", (_, page, placed) => {
  expect(kinPageWithLines(page, KIN_MONEY_SECTION, ["Kin's line."])).toBe(placed);
});

it.each([
  ["three paragraphs", "First.\n\nSecond.\n\nThird.", ["First.", "Second.", "Third."]],
  ["CRLF", "First.\r\n\r\nSecond.", ["First.", "Second."]],
  ["Hindi and an emoji", "समय तय है।\n\n👍", ["समय तय है।", "👍"]],
  ["one paragraph", "First.", ["First."]],
  [
    "five paragraphs",
    "One.\n\nTwo.\n\nThree.\n\nFour.\n\nFive.",
    ["One.\n\nTwo.\n\nThree.\n\nFour.\n\nFive."],
  ],
  ["whitespace-only lines", "First.\n \t\nSecond.", ["First.", "Second."]],
  ["single newlines", "First.\nSecond.", ["First.\nSecond."]],
  ["empty paragraphs and edges", " \n\n First.  \n\n\n  Second.\n \n ", ["First.", "Second."]],
  ["an empty reply", " \n\t ", []],
])("splits replies with %s", (_, body, bubbles) => {
  expect(kinReplyBubbles(body)).toEqual(bubbles);
});

it("splits at the bubble limit", () => {
  const paragraphs = Array.from({ length: KIN_REPLY_BUBBLES_MAX }, (_, i) => `Paragraph ${i + 1}.`);
  expect(kinReplyBubbles(paragraphs.join("\n\n"))).toEqual(paragraphs);
});

it.each([
  ["a heading", "## Work"],
  ["a label", "Today:"],
  ["a list item", "- An item"],
  ["a table", "| Work | State |\n| --- | --- |\n| Call | Done |"],
  ["a fence", "\`\`\`txt\nFirst line.\n\nLast line.\n\`\`\`"],
  ["a doc fence", "\`\`\`kin_doc Plan\nd_test000001\n\`\`\`"],
  ["a figure fence", figure],
  ["a figure line", "[This week](kin-figure:f_test000001)"],
  ["a quote", "> A quoted line."],
  ["a subject line", "Subject: Tidewater Freight"],
  ["a salutation", "Hi Meera,"],
  ["a sign-off", "Thanks,"],
  ["a standalone intro", "Three steps for Tidewater:"],
  ["indented code", "    vp test run"],
  ["tab-indented code", "\tvp test run"],
])("keeps a reply with %s whole", (_, block) => {
  const body = `An introduction.\n\n${block}\n\nA closing line.`;
  expect(kinReplyBubbles(body)).toEqual([body]);
});

it("keeps indentation on the opening line of a reply", () => {
  const body = "    vp test run\n\nThen push.";
  expect(kinReplyBubbles(body)).toEqual([body]);
});
