// The release check's Markdown summary and self-contained HTML page.
import type { Findings, Recorded, compare } from "../kin-release-check.ts";

const short = (sha: string) => sha.slice(0, 12);

export type Comparison = ReturnType<typeof compare> & { readonly against: string };

const line = (one: Recorded) =>
  `\`${one.fingerprint}\` ${one.stage} · ${one.check} · ${one.step}${one.role === "-" ? "" : ` · ${one.role}`}${one.message ? ` — ${one.message}` : ""}`;

export const markdown = (report: Findings, diff: Comparison, exit: number) => {
  const list = (title: string, items: ReadonlyArray<Recorded>) => [
    `## ${title} (${items.length})`,
    "",
    ...(items.length === 0 ? ["None."] : items.map((one) => `- ${line(one)}`)),
    "",
  ];
  return [
    `# Kin release check: ${short(report.commit)} (${report.mode})`,
    "",
    `Against ${diff.against}. Static checks since ${report.base}. Exit ${exit}. Model turns: ${report.modelTurns}; provider CLI calls blocked: ${report.blockedProviderCalls}.`,
    "",
    "| Stage | Result | Time | Note |",
    "| --- | --- | --- | --- |",
    ...report.stages.map(
      (one) => `| ${one.stage} | ${one.status} | ${one.seconds}s | ${one.note} |`,
    ),
    "",
    ...list("NEW", diff.new),
    ...list("FIXED", diff.fixed),
    ...list("STILL PRESENT", diff.still),
    ...(exit === 0
      ? [
          `Deploy this commit: \`sudo -iu kin ~/t3code/ops/kin/host/update.sh ${report.commit}\``,
          "",
        ]
      : []),
  ].join("\n");
};

const escape = (text: string) =>
  text.replace(
    /[&<>"]/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]!,
  );

export const html = (report: Findings, diff: Comparison, exit: number) => {
  const list = (title: string, kind: string, items: ReadonlyArray<Recorded>) => `
  <section><h2>${title} <span class="count">${items.length}</span></h2>${
    items.length === 0
      ? `<p class="muted">None.</p>`
      : `<ul>${items
          .map(
            (one) =>
              `<li class="${kind}"><code>${one.fingerprint}</code> <b>${escape(one.stage)}</b> · ${escape(one.check)} · ${escape(one.step)}${
                one.role === "-" ? "" : ` · <i>${escape(one.role)}</i>`
              }${one.message ? `<div class="muted">${escape(one.message)}</div>` : ""}</li>`,
          )
          .join("")}</ul>`
  }</section>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kin release check ${short(report.commit)}</title>
<style>
  :root { color-scheme: light dark; --text: var(--kin-text, #1d1d1f); --muted: var(--kin-muted, #6e6e73);
    --line: var(--kin-line, #d2d2d7); --card: var(--kin-card, rgba(0,0,0,.03));
    --new: var(--kin-new, #c62828); --fixed: var(--kin-fixed, #2e7d32); --still: var(--kin-still, #8d6e00); }
  @media (prefers-color-scheme: dark) { :root { --text: var(--kin-text, #f5f5f7); --muted: var(--kin-muted, #a1a1a6);
    --line: var(--kin-line, #3a3a3c); --card: var(--kin-card, rgba(255,255,255,.05));
    --new: var(--kin-new, #ff6b6b); --fixed: var(--kin-fixed, #66bb6a); --still: var(--kin-still, #e0b100); } }
  body { color: var(--text); font: 14px/1.5 system-ui, -apple-system, sans-serif; max-width: 960px; margin: 24px auto; padding: 0 16px; }
  table { border-collapse: collapse; width: 100%; } td, th { border-bottom: 1px solid var(--line); padding: 6px 8px; text-align: left; }
  section { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 4px 16px; margin: 16px 0; }
  ul { padding-left: 18px; } li { margin: 6px 0; } code { font-size: 12px; }
  .muted { color: var(--muted); } .count { color: var(--muted); font-weight: normal; }
  li.new { color: var(--new); } li.fixed { color: var(--fixed); } li.still { color: var(--still); }
  li .muted, li code { color: var(--muted); }
</style></head><body>
<h1>Kin release check · ${short(report.commit)} · ${report.mode}</h1>
<p class="muted">Against ${escape(diff.against)}. Static checks since ${escape(report.base)}. Exit ${exit}. Model turns ${report.modelTurns}; provider CLI calls blocked ${report.blockedProviderCalls}. ${escape(report.startedAt)} → ${escape(report.finishedAt)}.</p>
<table><thead><tr><th>Stage</th><th>Result</th><th>Time</th><th>Note</th></tr></thead><tbody>
${report.stages.map((one) => `<tr><td>${one.stage}</td><td>${one.status}</td><td>${one.seconds}s</td><td class="muted">${escape(one.note)}</td></tr>`).join("\n")}
</tbody></table>
${list("NEW", "new", diff.new)}${list("FIXED", "fixed", diff.fixed)}${list("STILL PRESENT", "still", diff.still)}
</body></html>
`;
};
