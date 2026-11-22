import { assert, it } from "@effect/vitest";

import { withArticle } from "./article.ts";

it("puts a or an before a word by how it is said", () => {
  const words = ["invoice", "task", "user", "unopened", "hour", "euro", "SVG", "PDF", "opencode"];
  assert.deepStrictEqual(
    words.map((word) => withArticle(word)).concat(withArticle("expense", "A")),
    [
      "an invoice",
      "a task",
      "a user",
      "an unopened",
      "an hour",
      "a euro",
      "an SVG",
      "a PDF",
      "an opencode",
      "An expense",
    ],
  );
});
