type Entry = { mode: string; sha: string };

export const uniqueMergeBase = (
  local: ReadonlyMap<string, ReadonlyArray<string>>,
  remote: ReadonlyMap<string, ReadonlyArray<string>>,
) => {
  const common = new Set([...local.keys()].filter((sha) => remote.has(sha)));
  const candidates = new Set(common);
  for (const sha of common) for (const parent of local.get(sha) ?? []) candidates.delete(parent);
  return candidates.size === 1 ? [...candidates][0] : undefined;
};

export const mergeMemoryFiles = (
  base: ReadonlyMap<string, Buffer>,
  local: ReadonlyMap<string, Buffer>,
  remote: ReadonlyMap<string, Buffer>,
  baseEntries: ReadonlyMap<string, Entry>,
  localEntries: ReadonlyMap<string, Entry>,
  remoteEntries: ReadonlyMap<string, Entry>,
) => {
  const files = new Map(remote);
  const modes = new Map([...remoteEntries].map(([file, entry]) => [file, entry.mode]));
  const same = (a: Buffer | undefined, b: Buffer | undefined) =>
    a === undefined ? b === undefined : b !== undefined && a.equals(b);
  for (const file of new Set([...base.keys(), ...local.keys()])) {
    const before = baseEntries.get(file);
    const after = localEntries.get(file);
    if (file === "INDEX.md" || (before?.sha === after?.sha && before?.mode === after?.mode))
      continue;
    const original = base.get(file) ?? Buffer.alloc(0);
    const bytes = local.get(file);
    const journal = file.startsWith("journal/");
    if (journal && (!bytes || !bytes.subarray(0, original.length).equals(original)))
      return undefined;
    if (same(remote.get(file), base.get(file)) && before?.mode === modes.get(file)) {
      if (bytes) {
        files.set(file, bytes);
        modes.set(file, after?.mode ?? "100644");
      } else {
        files.delete(file);
        modes.delete(file);
      }
    } else if (
      journal &&
      ["100644", "100755"].includes(after?.mode ?? "") &&
      after?.mode === modes.get(file) &&
      remote.get(file)?.subarray(0, original.length).equals(original)
    ) {
      files.set(file, Buffer.concat([remote.get(file)!, bytes!.subarray(original.length)]));
    } else return undefined;
  }
  return { files, modes };
};
