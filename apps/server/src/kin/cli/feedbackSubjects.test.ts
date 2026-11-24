import { expect, it } from "@effect/vitest";
import type { Command } from "effect/cli";

import { makeCli } from "../../binCli.ts";
import { resolveFeedbackSubject } from "../../feedback/FeedbackReport.ts";
import { KIN_CLI_COMMANDS } from "./feedbackSubjects.ts";

const listedPaths = (command: Command.Command.Any, path: string): ReadonlyArray<string> => [
  path,
  ...command.subcommands.flatMap((group) =>
    group.commands
      .filter((child) => !child.unlisted)
      .flatMap((child) => listedPaths(child, `${path} ${child.name}`)),
  ),
];

it("every listed t3 kin command is a feedback subject", () => {
  const kinPaths = listedPaths(makeCli({ cloudEnabled: true }), "t3").filter(
    (path) => path === "t3 kin" || path.startsWith("t3 kin "),
  );
  expect([...KIN_CLI_COMMANDS].sort()).toEqual([...kinPaths].sort());
  for (const path of kinPaths) expect(resolveFeedbackSubject(path, [])).toBe(path);
});
