// @effect-diagnostics nodeBuiltinImport:off - a pure path check that T3 core calls without a Path service.
import * as NodePath from "node:path";

import { type KinWorkerId, ThreadId } from "@t3tools/contracts";

/** A Kin worker's thread on this server; `WorkIsolation` gives it file tools in its worktree only. */
export const workThreadPrefix = "kin-work:";
export const localThreadId = (workerId: KinWorkerId) =>
  ThreadId.make(`${workThreadPrefix}${workerId}`);
export const isWorkThread = (threadId: string) => threadId.startsWith(workThreadPrefix);

/** Whether `root` is inside Kin's state (`<stateDir>/kin`): an agent's memory and notes. */
export const isKinWorkspace = (stateDir: string, root: string) => {
  const relative = NodePath.relative(NodePath.join(stateDir, "kin"), NodePath.resolve(root));
  return relative !== "" && !relative.startsWith("..") && !NodePath.isAbsolute(relative);
};
