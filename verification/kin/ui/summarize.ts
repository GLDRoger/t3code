// Reads each role's Bombadil trace and writes summary.json: actions, distinct screens, violations.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const out = NodePath.resolve(process.argv[2] ?? ".");
const screenOf = (url: string) => {
  const u = new URL(url);
  const keys = [...u.searchParams.keys()].sort().join("+");
  return u.pathname.replace(/^\/kin\/[^/]+\/[^/]+/, "") + (keys ? `?${keys}` : "");
};
const summary: Record<string, unknown> = {};
for (const role of NodeFS.readdirSync(out)) {
  const trace = NodePath.join(out, role, "trace", "trace.jsonl");
  if (!NodeFS.existsSync(trace)) continue;
  const lines = NodeFS.readFileSync(trace, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const screens = new Set<string>();
  const exact = new Set<string>();
  const violations = new Map<string, { count: number; first: number }>();
  lines.forEach((line, i) => {
    screens.add(screenOf(line.state.url));
    exact.add(line.state.url.replace(/^https?:\/\/[^/]+\/kin\/[^/]+\/[^/]+/, ""));
    for (const v of line.violations ?? []) {
      const name = v.name ?? v.property ?? JSON.stringify(v).slice(0, 80);
      const seen = violations.get(name);
      if (seen) seen.count++;
      else violations.set(name, { count: 1, first: i });
    }
  });
  summary[role] = {
    actions: lines.filter((l) => l.action !== null).length,
    screens: screens.size,
    urls: exact.size,
    screenList: [...screens].sort(),
    violations: Object.fromEntries(violations),
  };
  console.log(
    `[kin-ui] ${role}: ${lines.length - 1} actions, ${screens.size} screens (${exact.size} addresses), violated: ${[...violations.keys()].join(", ") || "none"}`,
  );
}
NodeFS.writeFileSync(NodePath.join(out, "summary.json"), JSON.stringify(summary, null, 2));
