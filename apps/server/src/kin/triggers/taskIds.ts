export const KIN_COMMAND_PREFIX = "kin:";
// Upstream names a task created with a commandId `scheduled-task:${commandId}`.
export const KIN_TASK_PREFIX = `scheduled-task:${KIN_COMMAND_PREFIX}`;
export const KIN_SCHEDULE_TASK_PREFIX = `${KIN_TASK_PREFIX}schedule:`;

/** A native task an older Kin left behind: Kin's prefix, not a schedule, and no Kin row names it. */
export const isStrayKinTask = (taskId: string, hasSourceRow: boolean) =>
  taskId.startsWith(KIN_TASK_PREFIX) &&
  !taskId.startsWith(KIN_SCHEDULE_TASK_PREFIX) &&
  !hasSourceRow;
