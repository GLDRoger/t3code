import { AuthKinTasksScope, type AuthEnvironmentScope } from "@t3tools/contracts";
import * as Context from "effect/Context";

/** True only inside the tasks endpoint's own check of a key; everywhere else a key is no session. */
export class TasksKeyAudience extends Context.Reference<boolean>("kin/tasksKey/TasksKeyAudience", {
  defaultValue: () => false,
}) {}

export const isTasksKey = (scopes: ReadonlyArray<AuthEnvironmentScope>) =>
  scopes.includes(AuthKinTasksScope);
