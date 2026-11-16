// Prints the steps before each violation in a role's trace: node explain.ts <out>/<role> [steps]
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const dir = NodePath.resolve(process.argv[2] ?? ".");
const steps = Number(process.argv[3] ?? 8);
const lines = NodeFS.readFileSync(NodePath.join(dir, "trace", "trace.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));
const where = (url: string) => url.replace(/^https?:\/\/[^/]+\/kin\/[^/]+\/[^/]+/, "") || "/";
const snap = (line: { snapshots: { name: string; value: unknown }[] }, name: string) =>
  line.snapshots.find((s) => s.name === name)?.value as Record<string, unknown> | undefined;
export const describe = (action: unknown): string => {
  if (action === null) return "start";
  if (typeof action === "string") return action;
  const a = action as Record<string, { fingerprint?: Record<string, string | null> }>;
  const click = a.Click ?? a.DoubleClick;
  if (click?.fingerprint) {
    const fp = click.fingerprint;
    const name =
      fp.accessible_name ?? fp.accessibleName ?? fp.text_content ?? fp.textContent ?? `<${fp.tag}>`;
    return `tap "${name.replace(/\s+/g, " ").slice(0, 60)}"`;
  }
  return Object.keys(a)[0] ?? "?";
};
const seen = new Set<string>();
lines.forEach((line, i) => {
  for (const v of line.violations ?? []) {
    if (seen.has(v.name)) continue;
    seen.add(v.name);
    console.log(`\n=== ${v.name} at step ${i}`);
    for (let j = Math.max(1, i - steps); j <= i; j++)
      console.log(`  ${j}. ${describe(lines[j].action)} → ${where(lines[j].state.url)}`);
    const s = snap(line, "screen");
    if (s)
      console.log(
        `  dialogs: ${JSON.stringify(s.dialogTitles)}\n  text: ${String(s.text).replace(/\s+/g, " ").slice(0, 600)}`,
      );
  }
});
