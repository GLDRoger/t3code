// @effect-diagnostics nodeBuiltinImport:off - a pure path check that T3 core calls without a Path service.
import * as NodePath from "node:path";

/** Whether `root` is inside Kin's state (`<stateDir>/kin`): an agent's memory and notes. */
export const isKinWorkspace = (stateDir: string, root: string) => {
  const relative = NodePath.relative(NodePath.join(stateDir, "kin"), NodePath.resolve(root));
  return relative !== "" && !relative.startsWith("..") && !NodePath.isAbsolute(relative);
};
