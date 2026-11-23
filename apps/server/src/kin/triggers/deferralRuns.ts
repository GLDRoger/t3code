import type { KinOrgId, MemoryItemHead } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { memoryDateMillis } from "../memory/frontMatter.ts";

/** A deferral's run as taps left it: memory keeps its own due and status (nothing is written). */
export interface DeferralRun {
  readonly state: string;
  readonly dueAt: number | null;
  readonly movedFrom: number | null;
  readonly updatedAt: number;
}

/**
 * A deferral as its run makes it, for every reader that reports one: cancelled by a tap reads
 * cancelled, moved to Monday reads at its new due (`movedAt`), and one whose work was handed over
 * (`started`) is no longer due or missed. A run that no longer matches memory's due changes nothing.
 */
export type DeferralHead<H extends MemoryItemHead = MemoryItemHead> = H & {
  /** When a tap moved it, so a day's summary lists what moved that day. */
  readonly movedAt?: number;
  readonly started?: true;
};

function withRun<H extends MemoryItemHead>(
  head: H,
  run: DeferralRun | undefined,
): DeferralHead<H> {
  if (run === undefined || head.kind !== "deferral" || head.status !== "open") return head;
  const due = memoryDateMillis(head.due);
  const current = run.dueAt === due || (run.movedFrom !== null && run.movedFrom === due);
  if (!current || run.dueAt === null) return head;
  if (run.state === "undone") return { ...head, status: "cancelled" };
  const moved =
    run.movedFrom !== null && run.dueAt !== due
      ? { due: DateTime.formatIso(DateTime.makeUnsafe(run.dueAt)), movedAt: run.updatedAt }
      : {};
  return run.state === "started" ? { ...head, ...moved, started: true } : { ...head, ...moved };
}

/** Every deferral run of the org, by item. */
const deferralRuns = Effect.fn("Deferrals.runs")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    itemId: string;
    state: string;
    dueAt: number | null;
    movedFrom: number | null;
    updatedAt: number;
  }>`SELECT item_id AS "itemId", state, due_at AS "dueAt",
      json_extract(snapshot_json, '$.movedFrom') AS "movedFrom", updated_at AS "updatedAt"
    FROM kin_deferral_runs WHERE org_id = ${orgId} ORDER BY item_id`;
  return new Map<string, DeferralRun>(rows.map(({ itemId, ...run }) => [itemId, run]));
});

/** `withRun` over a list, reading the org's runs once. */
export const withRuns = Effect.fn("Deferrals.withRuns")(function* <H extends MemoryItemHead>(
  orgId: KinOrgId,
  heads: ReadonlyArray<H>,
) {
  const runs = heads.some((head) => head.kind === "deferral")
    ? yield* deferralRuns(orgId)
    : new Map<string, DeferralRun>();
  return heads.map((head) => withRun(head, runs.get(head.id)));
});
