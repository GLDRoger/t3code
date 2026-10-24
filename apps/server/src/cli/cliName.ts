/**
 * `kin` and `t3` share one entry. npm and the desktop shim often resolve
 * argv to the real script, so the invoked name also comes from `KIN_CLI_NAME`
 * (set by the `kin` launcher) and from `T3CODE_CLI_PATH`.
 */
function basename(value: string): string {
  const slash = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  return slash === -1 ? value : value.slice(slash + 1);
}

export function resolveKinCliName(input: {
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly argv?: ReadonlyArray<string> | undefined;
}): "kin" | "t3" {
  const explicit = input.env?.KIN_CLI_NAME?.trim().toLowerCase();
  if (explicit === "kin") return "kin";
  const candidates = [input.env?.T3CODE_CLI_PATH, input.argv?.[1]];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate.length === 0) continue;
    const base = basename(candidate).toLowerCase();
    if (base === "kin" || base === "kin.cmd" || base === "kin.mjs" || base === "kin.exe") {
      return "kin";
    }
  }
  return "t3";
}
