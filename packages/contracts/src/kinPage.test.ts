import { expect, it } from "@effect/vitest";
import {
  KIN_MONEY_SECTION,
  kinPageGist,
  kinPageShape,
  kinPageWithLines,
  kinPlainBody,
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
