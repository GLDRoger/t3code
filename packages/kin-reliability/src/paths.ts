// @effect-diagnostics nodeBuiltinImport:off - Package paths are resolved once from import.meta.url.
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = NodePath.dirname(fileURLToPath(import.meta.url));

export const packageRoot = NodePath.resolve(srcDir, "..");
export const bendDir = NodePath.join(packageRoot, "bend");
export const corpusDir = NodePath.join(packageRoot, "corpus");
export const configDir = NodePath.join(packageRoot, "config");
export const bendVersionFile = NodePath.join(packageRoot, "bend.version");
