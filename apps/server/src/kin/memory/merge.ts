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

/** Where the first line that differs starts, with the blank line that opens its journal entry. */
const unlandedFrom = (journal: Buffer, differs: number, floor: number) => {
  let start = differs;
  while (start > floor && journal[start - 1] !== 10) start--;
  return start > floor && journal.subarray(start - 1, start + 3).toString("latin1") === "\n## "
    ? start - 1
    : start;
};

const headings = (text: Buffer) =>
  text
    .toString("utf8")
    .split("\n")
    .filter((line) => line.startsWith("## "));

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
    // Both sides made this change, as when the remote squash-merged a batch of local commits.
    if (same(remote.get(file), bytes) && after?.mode === modes.get(file)) continue;
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
      const theirs = remote.get(file)!;
      const ours = bytes!;
      // Entries both sides hold are kept once, even when the base predates them: a landed batch
      // comes back in GitHub's copy, and only what follows it here is still unlanded.
      let shared = original.length;
      while (shared < ours.length && ours[shared] === theirs[shared]) shared++;
      if (shared === theirs.length) files.set(file, ours);
      else if (shared < ours.length) {
        const from = unlandedFrom(ours, shared, original.length);
        // Text both sides hold that differs inside an entry, or an entry under one heading on
        // both sides, was edited rather than added: refuse instead of keeping both versions.
        const atEntry =
          from === original.length || ours.subarray(from, from + 4).toString("latin1") === "\n## ";
        const unlanded = new Set(headings(ours.subarray(from)));
        if (!atEntry || headings(theirs.subarray(from)).some((heading) => unlanded.has(heading)))
          return undefined;
        files.set(file, Buffer.concat([theirs, ours.subarray(from)]));
      }
    } else return undefined;
  }
  return { files, modes };
};
