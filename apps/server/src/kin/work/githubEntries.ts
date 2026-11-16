import type { KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { KinRecords, type Writer } from "./KinRecords.ts";

/**
 * A merged PR or a closed issue closes every entry linked to it, with the event as evidence. No
 * agent turn is involved. A merge also names the GitHub issues linked to those entries, for Kin to
 * close.
 */
export const githubClosed = Effect.fn("KinGitHubEntries.githubClosed")(function* (input: {
  readonly orgId: KinOrgId;
  readonly repo: string;
  readonly number: number;
  readonly item: "pull_request" | "issue";
}) {
  const sql = yield* SqlClient.SqlClient;
  const records = yield* KinRecords;
  const pull = input.item === "pull_request";
  const url = `https://github.com/${input.repo}/${pull ? "pull" : "issues"}/${input.number}`;
  const rows = yield* sql<{ recordId: string; key: string; state: string }>`
    SELECT DISTINCT r.record_id AS "recordId", r.key, r.state FROM kin_records r
    WHERE r.org_id = ${input.orgId} AND (
      EXISTS (SELECT 1 FROM kin_record_links l WHERE l.org_id = r.org_id
        AND l.record_id = r.record_id AND l.kind = ${pull ? "pull_request" : "url"}
        AND lower(l.target) = lower(${url})))
    ORDER BY r.record_id`;
  const writer: Writer = { actor: { _tag: "system" }, via: "github" };
  for (const row of rows) {
    yield* records.link(input.orgId, writer, row.recordId, {
      kind: pull ? "pull_request" : "url",
      target: url,
      relation: "evidence",
      label: pull ? `PR #${input.number} merged` : `Issue #${input.number} closed`,
    });
    if (row.state !== "done" && row.state !== "dropped")
      yield* records.update(input.orgId, writer, row.key, { state: "done" });
  }
  const issues: Array<{ readonly repo: string; readonly number: number }> = [];
  if (pull && rows.length > 0)
    for (const link of yield* sql<{
      target: string;
    }>`SELECT DISTINCT l.target FROM kin_record_links l
      WHERE l.org_id = ${input.orgId} AND l.kind = 'url'
        AND l.record_id IN ${sql.in(rows.map((row) => row.recordId))}
      ORDER BY l.target`) {
      const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/([1-9][0-9]*)$/i.exec(
        link.target,
      );
      if (match !== null) issues.push({ repo: match[1]!, number: Number(match[2]) });
    }
  return { entries: rows.length, issues };
});
