// @effect-diagnostics nodeBuiltinImport:off - electron-builder calls this Node signing hook directly.
import { sign as signApplication, type SignOptions } from "@electron/osx-sign";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { KIN_SIGNER_ENTITLEMENTS_ENV, KIN_SIGNER_NESTED_PATH } from "./lib/kin-signer.ts";

export default async function sign(options: SignOptions): Promise<void> {
  const entitlements = process.env[KIN_SIGNER_ENTITLEMENTS_ENV];
  if (!entitlements) {
    await signApplication({ ...options, batchCodesignCalls: true });
    return;
  }
  const bundle = NodePath.resolve(options.app, "Contents", KIN_SIGNER_NESTED_PATH);
  const executable = NodePath.join(bundle, "Contents", "MacOS", "kin-signer");
  const profile = NodePath.join(bundle, "Contents", "embedded.provisionprofile");
  await Promise.all([
    NodeFSP.access(executable),
    NodeFSP.access(profile),
    NodeFSP.access(entitlements),
  ]);
  const ignore = Array.isArray(options.ignore)
    ? options.ignore
    : options.ignore
      ? [options.ignore]
      : [];
  await signApplication({
    ...options,
    // osx-sign discovers binary resources as well as executable code.
    ignore: (file) =>
      file === profile ||
      (file !== bundle &&
        file !== executable &&
        ignore.some((filter) =>
          typeof filter === "function" ? filter(file) : file.match(filter) !== null,
        )),
    batchCodesignCalls: true,
    optionsForFile: (file, context) => {
      const existing = options.optionsForFile?.(file, context);
      if (file === bundle || file === executable) {
        return {
          entitlements,
          hardenedRuntime: true,
          ...(existing?.timestamp !== undefined ? { timestamp: existing.timestamp } : {}),
        };
      }
      return existing ?? {};
    },
  });
}
