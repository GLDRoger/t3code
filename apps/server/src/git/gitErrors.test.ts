import { expect, it } from "vite-plus/test";

import { isNotGitRepositoryMessage } from "./gitErrors.ts";

it.each([
  ["fatal: not a git repository: /missing-git-directory", true],
  ["fatal: Not a Git Repository (or any of the parent directories): .git", true],
  ["fatal: gitfile does not point to a valid repository: /tmp/worktrees/feature/.git", true],
  ["fatal: Unable to create '/repo/.git/index.lock': File exists.", false],
  ["fatal: detected dubious ownership in repository at '/repo'", false],
])("classifies missing repository diagnostic %j", (message, expected) => {
  expect(isNotGitRepositoryMessage(message)).toBe(expected);
});
