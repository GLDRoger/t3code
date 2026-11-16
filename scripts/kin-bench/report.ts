/** kin-bench's outputs: a Markdown table, a comparison against an earlier run, an HTML page. */
import type { BenchResult, Metric } from "./stats.ts";

export interface Finding {
  readonly title: string;
  readonly number: string;
  readonly cause: string;
  readonly where: string;
  readonly worth: string;
}

export interface CompareLine {
  readonly key: string;
  readonly label: string;
  readonly unit: string;
  readonly old: number;
  readonly now: number;
  readonly change: number;
  readonly worse: boolean;
}

/** Per metric, the old and new median; worse past `threshold` percent is flagged. */
export function compareLines(
  old: BenchResult,
  now: BenchResult,
  threshold: number,
): Array<CompareLine> {
  const before = new Map(old.metrics.map((one) => [one.key, one]));
  return now.metrics.flatMap((metric) => {
    const previous = before.get(metric.key);
    if (previous === undefined) return [];
    const change =
      previous.median === 0
        ? metric.median === 0
          ? 0
          : 100
        : ((metric.median - previous.median) / previous.median) * 100;
    // A few milliseconds either way is noise, not a regression.
    const small = metric.unit === "ms" && Math.abs(metric.median - previous.median) < 5;
    return [
      {
        key: metric.key,
        label: metric.label,
        unit: metric.unit,
        old: previous.median,
        now: metric.median,
        change,
        worse: change > threshold && !small,
      },
    ];
  });
}

export const formatValue = (value: number, unit: string) => {
  if (!Number.isFinite(value)) return "–";
  if (unit === "bytes")
    return value >= 1_048_576
      ? `${(value / 1_048_576).toFixed(2)} MB`
      : `${(value / 1024).toFixed(1)} KB`;
  if (unit === "ms")
    return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value.toFixed(0)} ms`;
  if (unit === "percent") return `${value.toFixed(1)}%`;
  if (unit === "MB") return `${value.toFixed(0)} MB`;
  if (unit === "tokens") return `${(value / 1000).toFixed(1)}k`;
  return `${Math.round(value)}`;
};

const LABELS: Record<string, string> = {
  coldLoad: "Cold load to the Chats list",
  openLongChatCold: "Open the long chat (first time)",
  openLongChatWarm: "Open the long chat (again)",
  switchChat: "Switch to another chat",
  dockTasks: "Open Tasks",
  dockMoney: "Open Money",
  dockClients: "Open Clients",
  dockDocs: "Open Docs",
  taskSheet: "Open a task",
};
export const labelOf = (metric: Metric) => LABELS[metric.key] ?? metric.label;

export function renderMarkdown(
  result: BenchResult,
  comparison?: ReadonlyArray<CompareLine>,
  findings?: ReadonlyArray<Finding>,
): string {
  const lines = [
    `# Kin benchmark, ${result.commit.slice(0, 10)}`,
    "",
    `${result.at} · ${result.runs} runs per web action · run took ${result.durationS} s · seed ${Object.entries(
      result.seed,
    )
      .map(([key, value]) => `${key} ${value}`)
      .join(", ")}`,
    "",
  ];
  for (const group of ["web", "server", "wire", "prompt"] as const) {
    const rows = result.metrics.filter((one) => one.group === group);
    if (rows.length === 0) continue;
    lines.push(
      `## ${group}`,
      "",
      "| Metric | Median | p90 | Samples | Note |",
      "| --- | ---: | ---: | ---: | --- |",
    );
    for (const one of rows)
      lines.push(
        `| ${labelOf(one)} | ${formatValue(one.median, one.unit)} | ${formatValue(one.p90, one.unit)} | ${one.samples.length} | ${one.note ?? ""} |`,
      );
    lines.push("");
  }
  lines.push(
    "## Wire per action",
    "",
    "| Action | Frames in | KB in | Frames out | KB out | Largest |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const row of result.wire)
    lines.push(
      `| ${row.action} | ${row.framesIn} | ${(row.bytesIn / 1024).toFixed(1)} | ${row.framesOut} | ${(row.bytesOut / 1024).toFixed(1)} | ${formatValue(row.largest, "bytes")} |`,
    );
  lines.push(
    "",
    "## Refresh chatter (5 s after one change, every connected person)",
    "",
    "| Change | Frames in (all) | KB in (all) | Requests sent (all) | Per person |",
    "| --- | ---: | ---: | ---: | --- |",
  );
  for (const one of result.chatter) {
    const sum = (key: "framesIn" | "bytesIn" | "requestsOut") =>
      one.clients.reduce((total, client) => total + client[key], 0);
    lines.push(
      `| ${one.change} | ${sum("framesIn")} | ${(sum("bytesIn") / 1024).toFixed(1)} | ${sum("requestsOut")} | ${one.clients.map((client) => `${client.person} ${client.framesIn}/${client.requestsOut}`).join(", ")} |`,
    );
  }
  lines.push(
    "",
    "## Prompts",
    "",
    result.prompts.method,
    "",
    `System prompt (Kin instructions): ${result.prompts.systemTokens} tokens. Tools: ${result.prompts.tools.length}, model-facing ${formatValue(result.prompts.toolListBytes.modelFacing, "bytes")} (${formatValue(result.prompts.toolListBytes.withOutputSchemas, "bytes")} with output schemas).`,
    "",
    "| Turn kind | Agent | Turn prompt | Tools | Total | Cacheable | Largest sections |",
    "| --- | --- | ---: | ---: | ---: | ---: | --- |",
  );
  for (const turn of result.prompts.turns)
    lines.push(
      turn.reached
        ? `| ${turn.kind} | ${turn.agent} | ${turn.turnTokens} | ${turn.toolCount} / ${turn.toolTokens} | ${turn.totalTokens} | ${(turn.cacheableShare * 100).toFixed(0)}% | ${[
            ...turn.sections,
          ]
            .sort((a, b) => b.tokens - a.tokens)
            .slice(0, 3)
            .map((one) => `${one.name} ${one.tokens}${one.stable ? " (stable)" : ""}`)
            .join("; ")} |`
        : `| ${turn.kind} | ${turn.agent} | not reached: ${turn.why} | | | | |`,
    );
  lines.push(
    "",
    "Largest tools: " +
      result.prompts.tools
        .slice(0, 10)
        .map((tool) => `${tool.name} ${tool.tokens}`)
        .join(", "),
  );
  if (comparison !== undefined) {
    lines.push(
      "",
      "## Compared with the earlier run",
      "",
      "| Metric | Old | New | Change | |",
      "| --- | ---: | ---: | ---: | --- |",
    );
    for (const line of comparison)
      lines.push(
        `| ${line.label} | ${formatValue(line.old, line.unit)} | ${formatValue(line.now, line.unit)} | ${line.change > 0 ? "+" : ""}${line.change.toFixed(0)}% | ${line.worse ? "**worse**" : ""} |`,
      );
  }
  if (findings !== undefined && findings.length > 0) {
    lines.push("", "## What stands out", "");
    for (const [index, one] of findings.entries())
      lines.push(
        `${index + 1}. **${one.title}** (${one.number}). ${one.cause} \`${one.where}\`. ${one.worth}`,
      );
  }
  if (result.notes.length > 0)
    lines.push("", "## Notes", "", ...result.notes.map((note) => `- ${note}`));
  return `${lines.join("\n")}\n`;
}

const escape = (text: string) =>
  text.replace(
    /[&<>"]/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]!,
  );

/** One horizontal bar per row, scaled to the largest; a p90 tick when given. */
function bars(
  rows: ReadonlyArray<{
    label: string;
    value: number;
    p90?: number;
    text: string;
    tone?: "warn" | "bad";
  }>,
): string {
  const max = Math.max(1, ...rows.map((row) => Math.max(row.value, row.p90 ?? 0)));
  return `<div class="bars">${rows
    .map(
      (row) =>
        `<div class="row"><span class="label">${escape(row.label)}</span><span class="track"><span class="bar ${row.tone ?? ""}" style="width:${((row.value / max) * 100).toFixed(1)}%"></span>${
          row.p90 === undefined
            ? ""
            : `<span class="tick" style="left:${((row.p90 / max) * 100).toFixed(1)}%" title="p90"></span>`
        }</span><span class="value">${escape(row.text)}</span></div>`,
    )
    .join("")}</div>`;
}

const SECTION_COLORS = [
  "var(--c1)",
  "var(--c2)",
  "var(--c3)",
  "var(--c4)",
  "var(--c5)",
  "var(--c6)",
  "var(--c7)",
  "var(--c8)",
];

export function renderHtml(
  result: BenchResult,
  comparison?: ReadonlyArray<CompareLine>,
  findings?: ReadonlyArray<Finding>,
): string {
  const web = result.metrics.filter(
    (one) =>
      one.group === "web" &&
      one.unit === "ms" &&
      one.key !== "keystroke" &&
      !one.key.startsWith("scroll"),
  );
  const webTimes = bars(
    web.map((one) => ({
      label: labelOf(one),
      value: one.median,
      p90: one.p90,
      text: `${formatValue(one.median, "ms")} · p90 ${formatValue(one.p90, "ms")}`,
      ...(one.median > 1000
        ? { tone: "bad" as const }
        : one.median > 300
          ? { tone: "warn" as const }
          : {}),
    })),
  );
  const feel = result.metrics.filter((one) =>
    [
      "keystroke",
      "scrollChatSlowFrames",
      "scrollTasksSlowFrames",
      "idleCpuList",
      "idleCpuChat",
      "heapAfterWalk",
      "domNodes",
      "startupJs",
      "startupCss",
    ].includes(one.key),
  );
  const feelTable = feel
    .map(
      (one) =>
        `<tr><td>${escape(labelOf(one))}</td><td class="num">${formatValue(one.median, one.unit)}</td><td class="num">${formatValue(one.p90, one.unit)}</td><td>${escape(one.note ?? "")}</td></tr>`,
    )
    .join("");
  const reads = result.metrics.filter(
    (one) => one.group === "server" && one.key.startsWith("read."),
  );
  const server = bars(
    reads.map((one) => ({
      label: one.label,
      value: one.median,
      p90: one.p90,
      text: `${formatValue(one.median, "ms")} · ${one.note ?? ""}`,
      ...(one.median > 200
        ? { tone: "bad" as const }
        : one.median > 50
          ? { tone: "warn" as const }
          : {}),
    })),
  );
  const serverOther = result.metrics.filter(
    (one) => one.group === "server" && !one.key.startsWith("read."),
  );
  const wire = bars(
    result.wire
      .filter((row) => row.bytesIn > 0)
      .map((row) => ({
        label: row.action,
        value: row.bytesIn,
        text: `${formatValue(row.bytesIn, "bytes")} in · ${row.framesIn} frames · largest ${formatValue(row.largest, "bytes")}`,
        ...(row.bytesIn > 1_048_576
          ? { tone: "bad" as const }
          : row.bytesIn > 262_144
            ? { tone: "warn" as const }
            : {}),
      })),
  );
  const chatter = bars(
    result.chatter.map((one) => {
      const frames = one.clients.reduce((sum, client) => sum + client.framesIn, 0);
      const requests = one.clients.reduce((sum, client) => sum + client.requestsOut, 0);
      const bytes = one.clients.reduce((sum, client) => sum + client.bytesIn, 0);
      return {
        label: one.change,
        value: frames,
        text: `${frames} frames in · ${requests} requests back · ${formatValue(bytes, "bytes")}`,
      };
    }),
  );
  const reached = result.prompts.turns.filter((turn) => turn.reached);
  const maxTotal = Math.max(1, ...reached.map((turn) => turn.totalTokens));
  const names = [
    ...new Set(
      reached.flatMap((turn) =>
        [...turn.sections]
          .sort((a, b) => b.tokens - a.tokens)
          .slice(0, 5)
          .map((one) => one.name),
      ),
    ),
  ].slice(0, 6);
  const colorOf = (name: string) =>
    name === "System prompt"
      ? "var(--sys)"
      : name === "Tools"
        ? "var(--tools)"
        : (SECTION_COLORS[names.indexOf(name)] ?? "var(--rest)");
  const stacked = reached
    .map((turn) => {
      const parts = [
        { name: "System prompt", tokens: turn.systemTokens },
        { name: "Tools", tokens: turn.toolTokens },
        ...names.map((name) => ({
          name,
          tokens: turn.sections
            .filter((one) => one.name === name)
            .reduce((sum, one) => sum + one.tokens, 0),
        })),
        {
          name: "Other sections",
          tokens: turn.sections
            .filter((one) => !names.includes(one.name))
            .reduce((sum, one) => sum + one.tokens, 0),
        },
      ].filter((part) => part.tokens > 0);
      return `<div class="row"><span class="label">${escape(turn.kind)}<small>${escape(turn.agent)}</small></span><span class="track stack" style="width:${((turn.totalTokens / maxTotal) * 100).toFixed(1)}%">${parts
        .map(
          (part) =>
            `<span style="flex:${part.tokens};background:${colorOf(part.name)}" title="${escape(part.name)}: ${part.tokens} tokens"></span>`,
        )
        .join(
          "",
        )}</span><span class="value">${formatValue(turn.totalTokens, "tokens")} · ${(turn.cacheableShare * 100).toFixed(0)}% cacheable</span></div>`;
    })
    .join("");
  const legend = ["System prompt", "Tools", ...names, "Other sections"]
    .map((name) => `<span><i style="background:${colorOf(name)}"></i>${escape(name)}</span>`)
    .join("");
  const missing = result.prompts.turns
    .filter((turn) => !turn.reached)
    .map((turn) => `<li>${escape(turn.kind)}: ${escape(turn.why ?? "not reached")}</li>`)
    .join("");
  const tools = bars(
    result.prompts.tools
      .slice(0, 10)
      .map((tool) => ({ label: tool.name, value: tool.tokens, text: `${tool.tokens} tokens` })),
  );
  const compare =
    comparison === undefined
      ? ""
      : `<section><h2>Compared with the earlier run</h2><table><tr><th>Metric</th><th>Old</th><th>New</th><th>Change</th></tr>${comparison
          .map(
            (line) =>
              `<tr class="${line.worse ? "worse" : ""}"><td>${escape(line.label)}</td><td class="num">${formatValue(line.old, line.unit)}</td><td class="num">${formatValue(line.now, line.unit)}</td><td class="num">${line.change > 0 ? "+" : ""}${line.change.toFixed(0)}%</td></tr>`,
          )
          .join("")}</table></section>`;
  const stands =
    findings === undefined || findings.length === 0
      ? ""
      : `<section><h2>What stands out</h2><ol class="findings">${findings
          .map(
            (one) =>
              `<li><b>${escape(one.title)}</b> <span class="pill">${escape(one.number)}</span><p>${escape(one.cause)} <code>${escape(one.where)}</code></p><p class="worth">${escape(one.worth)}</p></li>`,
          )
          .join("")}</ol></section>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kin benchmark ${escape(result.commit.slice(0, 10))}</title>
<style>
:root{color-scheme:light dark;--fg:var(--kin-fg,#1d1d1f);--muted:var(--kin-muted,#6b6b70);--line:var(--kin-line,rgba(127,127,127,.25));--track:var(--kin-track,rgba(127,127,127,.12));--accent:var(--kin-accent,#3b6fd8);--warn:var(--kin-warn,#c98a12);--bad:var(--kin-bad,#d0453a);
--sys:#7a7f8c;--tools:#b5651d;--c1:#3b6fd8;--c2:#2f9e8f;--c3:#8a5cd0;--c4:#d0453a;--c5:#c98a12;--c6:#5a9e3a;--c7:#c0508a;--c8:#4aa3c8;--rest:#a3a7b0}
@media (prefers-color-scheme:dark){:root{--fg:var(--kin-fg,#ececef);--muted:var(--kin-muted,#9a9aa2);--accent:var(--kin-accent,#6d9bff)}}
body{color:var(--fg);font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:980px;margin:0 auto;padding:24px 16px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 10px}p.meta{color:var(--muted);margin:0 0 8px}
section{border-top:1px solid var(--line);padding-top:4px}
.bars .row{display:grid;grid-template-columns:minmax(150px,240px) 1fr minmax(170px,auto);gap:10px;align-items:center;margin:5px 0}
.label{font-size:13px}.label small{display:block;color:var(--muted);font-size:11px}.value{font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}
.track{position:relative;height:14px;background:var(--track);border-radius:3px;display:block}
.bar{position:absolute;inset:0 auto 0 0;background:var(--accent);border-radius:3px}.bar.warn{background:var(--warn)}.bar.bad{background:var(--bad)}
.tick{position:absolute;top:-3px;bottom:-3px;width:2px;background:var(--fg);opacity:.55}
.stack{display:flex;overflow:hidden;background:none}.stack span{height:100%}
.legend{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:12px;color:var(--muted);margin:6px 0 10px}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}
table{border-collapse:collapse;width:100%;font-size:13px}td,th{border-bottom:1px solid var(--line);padding:5px 6px;text-align:left}td.num{text-align:right;font-variant-numeric:tabular-nums}tr.worse td{color:var(--bad);font-weight:600}
.findings li{margin:0 0 12px}.findings p{margin:3px 0}.worth{color:var(--muted)}.pill{font-size:12px;border:1px solid var(--line);border-radius:10px;padding:1px 8px;margin-left:4px}
code{font-size:12px}
@media (max-width:640px){.bars .row{grid-template-columns:1fr;gap:2px}}
</style></head><body>
<h1>Kin benchmark</h1>
<p class="meta">Commit ${escape(result.commit.slice(0, 10))} · ${escape(result.at.slice(0, 16).replace("T", " "))} UTC · ${result.runs} runs per action · one run takes ${Math.round(result.durationS / 60)} min · invented company: ${result.seed.messagesInLongChat} messages in one chat, ${result.seed.tasks} tasks, ${result.seed.clients} clients, ${result.seed.docs} docs, ${result.seed.invoices + result.seed.expenses} money entries</p>
${stands}
<section><h2>How fast the web app answers</h2><p class="meta">Median bar, p90 tick. Amber over 0.3 s, red over 1 s.</p>${webTimes}
<table><tr><th>How it feels</th><th>Median</th><th>p90</th><th></th></tr>${feelTable}</table></section>
<section><h2>Server</h2><p class="meta">Time to answer one request from the owner on this data. Amber over 50 ms, red over 200 ms.</p>${server}
<table>${serverOther.map((one) => `<tr><td>${escape(one.label)}</td><td class="num">${formatValue(one.median, one.unit)}</td></tr>`).join("")}</table></section>
<section><h2>Data over the connection</h2><p class="meta">What the owner's browser received for each action.</p>${wire}
<h2>One change, every connected person</h2><p class="meta">Five people's browsers open; one change made; what all five received in the next 5 s.</p>${chatter}</section>
<section><h2>What an agent reads each turn</h2><p class="meta">Tokens per turn kind, split by part. ${escape(result.prompts.method)}</p><div class="legend">${legend}</div><div class="bars">${stacked}</div>${missing === "" ? "" : `<p class="meta">Not measured:</p><ul>${missing}</ul>`}
<h2>Largest tool descriptions</h2>${tools}</section>
${compare}
${result.notes.length === 0 ? "" : `<section><h2>Notes</h2><ul>${result.notes.map((note) => `<li>${escape(note)}</li>`).join("")}</ul></section>`}
</body></html>
`;
}
