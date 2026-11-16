import { describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/kin-failure-words", {
  filename: "apps/web/src/kin/Example.tsx",
});

describe("t3code/kin-failure-words", () => {
  rule.valid(
    "allows the mapping's words",
    `const failure = kinFailure(cause, "Couldn't load this list."); const label = KIN_RETRY;`,
  );

  rule.valid("allows the words in comments", `// Retry says try again.\nconst x = 1;`);

  // The fuzz's finding #2: a refused filter read as the connection, with a Retry that can't work.
  rule.invalid(
    "reports the old list error",
    `const node = <p>{KIN_LISTS.entriesFailed}. Check your connection.</p>;`,
  );

  rule.invalid(
    "reports a generic failure string",
    `const failed = "That didn't go through. Check your connection and try again.";`,
  );

  rule.invalid("reports a template", "const text = `Couldn't ${doing}. Try again.`;");
});
