#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
/**
 * Grades saved samples again with this checkout's cases and graders: `pnpm mcp-tool-use:regrade
 * <results.jsonl>... [--cases <file>]` prints pass counts per case, old → new, with how many passed
 * only within margin and the case's state. Rows with an error are skipped. Saved rubric verdicts
 * are kept, not asked again. A sample that stopped early and passes now is "cut short".
 */
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import * as Schema from "effect/Schema";

import { caseState, type Check, sampleState, type State } from "./margin.ts";
import { gradeSample, McpToolUseCase, pastedText, worldFilePaths } from "./run.ts";
import { shownText } from "./kin.ts";

const { values, positionals } = NodeUtil.parseArgs({
  allowPositionals: true,
  options: { cases: { type: "string", multiple: true } },
});
const caseFiles =
  values.cases ??
  NodeFS.readdirSync(new URL("./cases", import.meta.url))
    .filter((name) => name.endsWith(".ndjson"))
    .map((name) => NodeURL.fileURLToPath(new URL(`./cases/${name}`, import.meta.url)));
const decodeCase = Schema.decodeUnknownSync(Schema.fromJsonString(McpToolUseCase));
const lines = (file: string) =>
  NodeFS.readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "");
const cases = new Map(
  caseFiles.flatMap(lines).map((line) => [decodeCase(line).id, decodeCase(line)]),
);

for (const file of positionals) {
  const counts = new Map<
    string,
    { n: number; was: number; now: number; cut: number; states: Array<State> }
  >();
  for (const line of lines(file)) {
    const row = JSON.parse(line);
    const testCase = cases.get(row.id);
    if (testCase === undefined || row.error !== undefined) continue;
    // Claude rows carry their responses, so their text is read again as the chat shows it.
    const responses = Array.isArray(row.transcript)
      ? row.transcript.flatMap((message: { role?: string; content?: unknown }) =>
          message.role === "assistant" && Array.isArray(message.content) ? [message.content] : [],
        )
      : [];
    const graded = responses.length === 0 ? row : { ...row, text: shownText(responses) };
    const rubric: Array<Check> = Array.isArray(row.checks)
      ? row.checks.filter((check: Check) => check.check.startsWith("rubric "))
      : [];
    const checks = [
      ...gradeSample(testCase.expect, graded, pastedText(testCase), worldFilePaths(testCase)),
      ...rubric,
    ];
    const failed = checks.filter((check) => !check.pass);
    const cut = failed.length === 0 && row.stopReason === "failed_early";
    const state = cut ? "fail" : sampleState(checks);
    const pass = state !== "fail";
    const count = counts.get(row.id) ?? { n: 0, was: 0, now: 0, cut: 0, states: [] };
    count.n++;
    count.states.push(state);
    if (row.pass) count.was++;
    if (pass) count.now++;
    if (cut) count.cut++;
    counts.set(row.id, count);
    if (pass !== row.pass || cut)
      console.log(
        `${row.id}#${count.n} ${row.pass ? "pass" : "FAIL"} → ${cut ? "cut short" : state === "margin" ? "pass within margin" : pass ? "pass" : "FAIL"}${failed.length > 0 ? `: ${failed.map((check) => check.check.slice(0, 100)).join(" | ")}` : ""}`,
      );
  }
  console.log(`\n${file}\n| case | was | now | case state |\n| --- | --- | --- | --- |`);
  for (const [id, { n, was, now, cut, states }] of counts) {
    const margin = states.filter((state) => state === "margin").length;
    console.log(
      `| ${id} | ${was}/${n} | ${now}/${n}${margin > 0 ? `, ${margin} within margin` : ""}${cut > 0 ? ` (${cut} cut short)` : ""}${was === now ? "" : " *"} | ${caseState(states, cases.get(id)?.margin) ?? "-"} |`,
    );
  }
}
