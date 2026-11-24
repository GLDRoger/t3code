export const offlineCatchUpWords = (
  from: string,
  to: string,
  counts: {
    readonly caughtUp: number;
    readonly older?: number;
    readonly scheduled?: number;
    readonly checkIns?: number;
  },
) => {
  const opening = `Kin was offline from ${from} to ${to}.`;
  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  const skipped = [
    [counts.older ?? 0, "older message"],
    [counts.scheduled ?? 0, "scheduled run"],
    [counts.checkIns ?? 0, "check-in"],
  ] as const;
  const parts = skipped.filter(([n]) => n > 0).map(([n, noun]) => count(n, noun));
  const caughtUp = `Caught up ${count(counts.caughtUp, "message")}`;
  if (parts.length > 0) {
    const list =
      parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
    const verb = skipped.reduce((total, [n]) => total + n, 0) === 1 ? "was" : "were";
    const prefix = counts.caughtUp === 0 ? opening : `${opening} ${caughtUp};`;
    return `${prefix} ${list} ${verb} skipped.`;
  }
  if (counts.older !== 0 || counts.scheduled !== 0 || counts.checkIns !== 0)
    return counts.caughtUp === 0 ? opening : `${opening} ${caughtUp}.`;
  return counts.caughtUp === 0
    ? `${opening} Nothing arrived while it was off.`
    : `${opening} ${caughtUp}; nothing was skipped.`;
};
