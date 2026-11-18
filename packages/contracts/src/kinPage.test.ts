import { expect, it } from "@effect/vitest";
import { kinPageGist, kinPageShape, kinPlainBody } from "./kinPage.ts";

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
