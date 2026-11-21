// @effect-diagnostics nodeBuiltinImport:off globalConsole:off anyUnknownInErrorContext:off - a nightly report; each read fails in its own way and a failure is a refusal.
// Kin's wire budget (src/kin/wireBudget.test.ts) at a real company's size: KIN_WIRE_ENTRIES work
// entries (tasks, invoices and expenses) over a year, with clients and docs in proportion. Each hot
// read, as owner, co-owner and member, must keep to its byte ceiling (`byteCeiling`) and its time
// ceiling; exits 1 naming each one that doesn't. Nightly in .github/workflows/kin.yml; by hand:
//   KIN_WIRE_ENTRIES=20000 node apps/server/scripts/kin-wire-scaled.ts
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as References from "effect/References";
import * as TestClock from "effect/testing/TestClock";

import {
  as,
  byteCeiling,
  layer,
  READS,
  seed,
  type SeedSize,
  VIEWERS,
  wireBytes,
} from "../src/kin/wireBudget.testkit.ts";

const entries = Number(process.env.KIN_WIRE_ENTRIES ?? 20_000);
const size: SeedSize = {
  tasks: Math.round(entries * 0.88),
  invoices: Math.round(entries * 0.04),
  expenses: Math.round(entries * 0.08),
  clients: Math.round(entries * 0.1),
  projects: Math.round(entries * 0.008),
  docs: Math.round(entries * 0.04),
};

/** 3x the slowest viewer's median read at 20,000 entries, over three runs, 50 ms at least. */
const CEILING_MS: Record<string, number> = {
  taskPage: 550,
  taskPageLegacy: 550,
  dueToday: 150,
  summary: 300,
  money: 250,
  moneyLegacy: 250,
  lists: 50,
  docsPage: 50,
  docsPageLegacy: 50,
  docsTotal: 50,
  docsChangedThisWeek: 50,
  needsYou: 850,
  attentionAll: 850,
  attentionMoney: 1000,
  clients: 450,
  projects: 150,
};

const median = (values: ReadonlyArray<number>) => [...values].sort((a, b) => a - b)[1]!;

const program = Effect.gen(function* () {
  const seedStart = performance.now();
  yield* seed(size);
  const seeded = Object.entries(size).map(([what, count]) => `${count} ${what}`);
  const report = [`seeded ${seeded.join(", ")} in ${Math.round(performance.now() - seedStart)} ms`];
  const failures: Array<string> = [];
  for (const [viewer, personId] of VIEWERS)
    for (const read of READS) {
      const key = `${viewer}.${read.name}`;
      const times: Array<number> = [];
      let bytes = 0;
      let refused = false;
      for (let run = 0; run < 3; run++) {
        const start = performance.now();
        const result = yield* Effect.result(read.run(as(personId), personId));
        times.push(performance.now() - start);
        if (result._tag === "Failure") refused = true;
        else bytes = wireBytes(read.schema, result.success);
      }
      const ms = Math.round(median(times));
      const problems: Array<string> = [];
      const most = byteCeiling(read);
      if (most !== undefined && bytes > most) problems.push(`${bytes} B, over ${most} B`);
      const ceiling = CEILING_MS[read.name];
      if (ceiling === undefined) problems.push("no time ceiling");
      else if (ms > ceiling) problems.push(`${ms} ms, over ${ceiling} ms`);
      const shown = refused ? "refused" : `${bytes} B`;
      report.push(
        `${problems.length === 0 ? "ok  " : "FAIL"} ${key.padEnd(30)} ${shown.padStart(10)} ${`${ms} ms`.padStart(9)}${read.grows === true ? "  (grows)" : ""}${problems.length > 0 ? `  ${problems.join("; ")}` : ""}`,
      );
      if (problems.length > 0) failures.push(`${key}: ${problems.join("; ")}`);
    }
  return { report, failures };
});

const quiet = Layer.mergeAll(TestClock.layer(), Layer.succeed(References.MinimumLogLevel, "Warn"));
const { report, failures } = await Effect.runPromise(
  program.pipe(Effect.provide(layer.pipe(Layer.provideMerge(quiet)))),
);
for (const line of report) console.log(line);
if (failures.length > 0) {
  console.error(`\n${failures.length} Kin read(s) over budget at ${entries} entries:`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(`\nEvery Kin hot read keeps to its ceilings at ${entries} entries.`);
