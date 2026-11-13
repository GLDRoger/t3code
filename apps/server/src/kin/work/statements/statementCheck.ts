// @effect-diagnostics nodeBuiltinImport:off -- a maintainer's check of the built reader, on one file named on the command line.
import * as NodeFS from "node:fs";

import * as Effect from "effect/Effect";

import { runReader } from "./statementReader.ts";
import { provenTable } from "./statementReading.ts";

/**
 * `__kin-statement-check <file>`: one read through the reader process exactly as the server runs
 * it, from a built artefact too. Prints what happened, never the file's rows.
 */
export const runStatementCheck = async (path: string) => {
  const run = await Effect.runPromise(runReader(new Uint8Array(NodeFS.readFileSync(path))));
  process.stdout.write(
    `${JSON.stringify({
      outcome: run.outcome._tag,
      ...(run.outcome._tag === "read"
        ? {
            rows: run.outcome.statement.rows.length,
            check: run.outcome.statement.check.status,
            ...(run.outcome.pages === undefined
              ? {}
              : {
                  dated: run.outcome.pages.map((page) => page.dated),
                  proven: provenTable(run.outcome.statement, run.outcome.pages) !== undefined,
                }),
          }
        : {}),
      ...(run.outcome._tag === "pages"
        ? { dated: run.outcome.pages.map((page) => page.dated) }
        : {}),
      ...(run.outcome._tag === "unreadable" ? { reason: run.outcome.reason } : {}),
      stopped: run.stopped ?? null,
      peakMb: Math.round(run.peakKib / 1024),
    })}\n`,
  );
};
