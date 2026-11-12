import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** After Kin's own directories; one this host lacks is skipped. */
const systemPath = ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"];
const systemShell = "/bin/bash";
/** Paths Claude Code loads or writes, taken from the provider's environment only once checked. */
export const pointerVariables = ["TMPDIR", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR"];

/** The owner's extra directories for every worker's `PATH`, in `KIN_WORKER_PATH`, comma-separated. */
export const ownerPath = (env: NodeJS.ProcessEnv) =>
  (env.KIN_WORKER_PATH ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

const inside = (parent: string, child: string) =>
  child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
const overlaps = (a: string, b: string) => inside(a, b) || inside(b, a);

/**
 * A worker's `PATH`, `SHELL` and the paths it loads, none from the provider's `PATH`: the server's
 * Node, Claude Code's directory, the system's, then the owner's. Each is used by its
 * real path, and left out, named in `dropped`, when it is relative, missing, or inside, equal to
 * or above a place in `writable`. Claude Code's own process runs what `PATH` finds, unsandboxed.
 */
export const workerPaths = Effect.fn("KinWorkSandbox.workerPaths")(function* (input: {
  readonly providerEnv: NodeJS.ProcessEnv;
  readonly claude: string | undefined;
  readonly ownerPath: ReadonlyArray<string>;
  /** Every place a worker or another task's worker can write. */
  readonly writable: ReadonlyArray<string>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const real = (entry: string) => fs.realPath(entry).pipe(Effect.orElseSucceed(() => undefined));
  const writable = (yield* Effect.forEach(input.writable, real)).filter(
    (entry): entry is string => entry !== undefined,
  );
  const dropped: Array<string> = [];
  const checked = Effect.fnUntraced(function* (
    name: string,
    entry: string,
    kind: "Directory" | "File" | undefined,
  ) {
    if (!entry.startsWith("/")) {
      dropped.push(`${name} ${entry}: not an absolute path`);
      return undefined;
    }
    const target = yield* real(entry);
    const info = target === undefined ? undefined : yield* fs.stat(target).pipe(Effect.option);
    if (
      target === undefined ||
      info?._tag !== "Some" ||
      (kind !== undefined && info.value.type !== kind)
    ) {
      dropped.push(`${name} ${entry}: no such ${kind === "File" ? "file" : "directory"}`);
      return undefined;
    }
    const writer = writable.find((place) => overlaps(place, target));
    if (writer !== undefined) {
      dropped.push(`${name} ${entry}: overlaps ${writer}, which a worker can write`);
      return undefined;
    }
    return target;
  });
  const node = yield* real(yield* HostProcess.ExecutablePath);
  // Kin's own lists: a directory this host doesn't have (yet) is skipped, not reported.
  const present = Effect.fnUntraced(function* (entries: ReadonlyArray<string>) {
    const found: Array<string> = [];
    for (const entry of entries) if ((yield* real(entry)) !== undefined) found.push(entry);
    return found;
  });
  const entries: Array<string> = [];
  for (const entry of [
    ...(node === undefined ? [] : [path.dirname(node)]),
    ...(input.claude?.startsWith("/") === true ? [path.dirname(input.claude)] : []),
    ...(yield* present(systemPath)),
    ...input.ownerPath,
  ]) {
    const target = yield* checked("PATH entry", entry, "Directory");
    if (target !== undefined && !entries.includes(target)) entries.push(target);
  }
  const env: Record<string, string> = { PATH: entries.join(":") };
  const shell = yield* checked("SHELL", systemShell, "File");
  if (shell !== undefined) env.SHELL = shell;
  for (const name of pointerVariables) {
    const value = input.providerEnv[name];
    if (value === undefined || value === "") continue;
    const target = yield* checked(
      name,
      value,
      name === "TMPDIR" || name === "SSL_CERT_DIR" ? "Directory" : "File",
    );
    if (target !== undefined) env[name] = target;
  }
  return { env, dropped };
});
