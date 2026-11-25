import type { KinOrgId, KinWorkPrincipal } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { KinRecords, type Writer } from "./KinRecords.ts";

const writer: Writer = { actor: { _tag: "system" }, via: "github" };
const groupOf = (originKey: string) => originKey.replace(/:(open|run):\d+$/, "");

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
  /**
   * A failing run's own key: each failing run after a close is a new entry. Without it, an entry
   * is one open episode of `group`, and the next starts only after GitHub closed the last.
   */
  readonly originKey?: string;
  readonly title: string;
  readonly url: string;
  readonly label: string;
  /** Past the cap: an entry it already has stays in step, and none is made. */
  readonly quiet?: boolean;
}

/**
 * Keeps one open Work entry per item that is open on GitHub now, held by `owner`. An open entry
 * of `prefix` that `open` doesn't name closes when `closedBy` says what closed it. An entry a
 * person or agent closed stays closed while its issue is open; one GitHub closed starts again,
 * and one dropped because Kin stopped watching the repo opens again.
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
  // Open entries, closed ones whose last state change wasn't GitHub's (someone closed them), and
  // ones Kin dropped when it stopped watching the repo (GitHub only ever closes as done).
  const rows = yield* sql<{
    recordId: string;
    key: string;
    title: string;
    originKey: string;
    state: string;
    lastVia: string;
  }>`
    SELECT "recordId", key, title, "originKey", state, "lastVia" FROM (SELECT r.record_id AS "recordId", r.key, r.title,
      r.origin_key AS "originKey", r.state, COALESCE((SELECT c.via FROM kin_record_changes c
        WHERE c.org_id = r.org_id AND c.record_id = r.record_id AND (c.kind = 'created'
          OR EXISTS (SELECT 1 FROM json_each(c.fields_json) f
            WHERE json_extract(f.value, '$.field') = 'state'))
        ORDER BY c.seq DESC LIMIT 1), '') AS "lastVia", r.created_at
      FROM kin_records r
      WHERE r.org_id = ${input.orgId} AND r.register_id = 'work'
        AND substr(r.origin_key, 1, ${input.prefix.length}) = ${input.prefix})
    WHERE NOT (state = 'done' AND "lastVia" = 'github')
    ORDER BY created_at, "recordId"`;
  const isOpen = (row: (typeof rows)[number]) => row.state !== "done" && row.state !== "dropped";
  const unwatched = (row: (typeof rows)[number]) =>
    row.state === "dropped" && row.lastVia === "github";
  const named = new Set(input.open.map((item) => item.group));
  for (const item of input.open) {
    const mine = rows.filter((row) => groupOf(row.originKey) === item.group);
    const open = mine.find(isOpen);
    if (open !== undefined) {
      if (open.title !== item.title)
        yield* records.update(input.orgId, writer, open.key, { title: item.title });
      continue;
    }
    if (item.quiet === true) continue;
    const back = mine.findLast(unwatched);
    if (back !== undefined) {
      yield* records.update(input.orgId, writer, back.key, {
        state: "open",
        ...(back.title === item.title ? {} : { title: item.title }),
      });
      continue;
    }
    if (item.originKey === undefined && mine.length > 0) continue;
    let originKey = item.originKey;
    if (originKey === undefined) {
      const episode = `${item.group}:open:`;
      const [count] = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM kin_records
        WHERE org_id = ${input.orgId} AND register_id = 'work'
          AND substr(origin_key, 1, ${episode.length}) = ${episode}`;
      originKey = `${episode}${(count?.count ?? 0) + 1}`;
    }
    yield* records.create(input.orgId, writer, {
      title: item.title,
      owner: input.owner,
      repo: input.repo,
      originKey,
      links: [{ kind: "url", target: item.url, relation: "source", label: item.label }],
    });
  }
  for (const row of rows) {
    if (!isOpen(row) || named.has(groupOf(row.originKey))) continue;
    const closed = input.closedBy(groupOf(row.originKey));
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

/** Open entries of repos Kin no longer watches are dropped, each with a note saying why. */
export const githubUnwatched = Effect.fn("KinGitHubEntries.githubUnwatched")(function* (input: {
  readonly orgId: KinOrgId;
  /** Lower-cased `owner/name` of every repo watched now. */
  readonly watched: ReadonlySet<string>;
}) {
  const sql = yield* SqlClient.SqlClient;
  const records = yield* KinRecords;
  const rows = yield* sql<{ recordId: string; key: string; repo: string | null }>`
    SELECT record_id AS "recordId", key, repo FROM kin_records
    WHERE org_id = ${input.orgId} AND register_id = 'work'
      AND (substr(origin_key, 1, 13) = 'github:issue:' OR substr(origin_key, 1, 10) = 'github:ci:')
      AND state NOT IN ('done', 'dropped')
    ORDER BY record_id`;
  for (const row of rows) {
    if (row.repo === null || input.watched.has(row.repo.toLowerCase())) continue;
    yield* records.link(input.orgId, writer, row.recordId, {
      kind: "url",
      target: `https://github.com/${row.repo}`,
      relation: "relates",
      label: `Kin stopped watching ${row.repo}`,
    });
    yield* records.update(input.orgId, writer, row.key, { state: "dropped" });
  }
});
