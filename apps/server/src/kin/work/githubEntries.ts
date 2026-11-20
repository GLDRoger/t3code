import type { KinOrgId, KinWorkPrincipal } from "@t3tools/contracts";
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

/** An open issue or a failing workflow, as one Work entry. */
export interface GitHubOpenItem {
  /** What the entry stands for, across its episodes: an issue, or a workflow on the default branch. */
  readonly group: string;
  /** Idempotent per episode: a workflow that recovers and fails again is a new entry. */
  readonly originKey: string;
  readonly title: string;
  readonly url: string;
  readonly label: string;
}

/**
 * Keeps one open Work entry per item that is open on GitHub now, held by `owner`. An open entry
 * of `prefix` that `open` doesn't name closes when `closedBy` says what closed it.
 */
export const githubOpenWork = Effect.fn("KinGitHubEntries.githubOpenWork")(function* (input: {
  readonly orgId: KinOrgId;
  readonly repo: string;
  readonly prefix: string;
  readonly owner: KinWorkPrincipal;
  readonly open: ReadonlyArray<GitHubOpenItem>;
  readonly closedBy: (
    group: string,
  ) => { readonly url: string; readonly label: string } | undefined;
}) {
  const sql = yield* SqlClient.SqlClient;
  const records = yield* KinRecords;
  const writer: Writer = { actor: { _tag: "system" }, via: "github" };
  const rows = yield* sql<{ recordId: string; key: string; title: string; originKey: string }>`
    SELECT record_id AS "recordId", key, title, origin_key AS "originKey" FROM kin_records
    WHERE org_id = ${input.orgId} AND register_id = 'work'
      AND substr(origin_key, 1, ${input.prefix.length}) = ${input.prefix}
      AND state NOT IN ('done', 'dropped')
    ORDER BY record_id`;
  const groupOf = (originKey: string) =>
    input.open.find((item) => originKey === item.group || originKey.startsWith(`${item.group}:`))
      ?.group;
  for (const item of input.open) {
    const row = rows.find((one) => groupOf(one.originKey) === item.group);
    if (row !== undefined) {
      if (row.title !== item.title)
        yield* records.update(input.orgId, writer, row.key, { title: item.title });
      continue;
    }
    yield* records.create(input.orgId, writer, {
      title: item.title,
      owner: input.owner,
      repo: input.repo,
      originKey: item.originKey,
      links: [{ kind: "url", target: item.url, relation: "source", label: item.label }],
    });
  }
  for (const row of rows) {
    if (groupOf(row.originKey) !== undefined) continue;
    const group = row.originKey.replace(/:run:\d+$/, "");
    const closed = input.closedBy(group);
    if (closed === undefined) continue;
    yield* records.link(input.orgId, writer, row.recordId, {
      kind: "url",
      target: closed.url,
      relation: "evidence",
      label: closed.label,
    });
    yield* records.update(input.orgId, writer, row.key, { state: "done" });
  }
});
