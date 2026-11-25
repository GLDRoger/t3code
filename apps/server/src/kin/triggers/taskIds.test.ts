import { assert, describe, it } from "@effect/vitest";

import { isStrayKinTask } from "./taskIds.ts";

describe("isStrayKinTask", () => {
  it.each([
    ["scheduled-task:kin:webhook:github-app", false, true],
    ["scheduled-task:kin:org-a:digest", false, true],
    ["scheduled-task:kin:schedule-inbox:org-a:lead-a", false, true],
    ["scheduled-task:kin:webhook:github-app", true, false],
    ["scheduled-task:kin:schedule:org-a:sch-invoices", true, false],
    ["scheduled-task:kin:schedule:org-a:sch-gone", false, false],
    ["scheduled-task:rhea-weekly-review", false, false],
    ["scheduled-task:kinship-newsletter", false, false],
    ["kin:webhook:github-app", false, false],
    ["weekly-review", true, false],
  ] as const)("%s with a source row %s is a stray: %s", (taskId, hasSourceRow, stray) => {
    assert.strictEqual(isStrayKinTask(taskId, hasSourceRow), stray);
  });
});
