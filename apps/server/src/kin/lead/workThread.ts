import { type KinWorkerId, ThreadId } from "@t3tools/contracts";

/** A Kin worker's thread on this server; `WorkIsolation` gives it file tools in its worktree only. */
export const workThreadPrefix = "kin-work:";
export const localThreadId = (workerId: KinWorkerId) =>
  ThreadId.make(`${workThreadPrefix}${workerId}`);
export const isWorkThread = (threadId: string) => threadId.startsWith(workThreadPrefix);
