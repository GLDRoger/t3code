import {
  formatKinWhen,
  KIN_TEXT_LOCALE,
  KinRecordKey,
  type KinOrgId,
  type KinPersonId,
  type KinRecordId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { githubRef, readGithubLinkSets } from "../triggers/deferralGithub.ts";
import { selectRecords, sensitiveNow, type RecordRow } from "../work/recordRows.ts";
import { sensitiveShown } from "../work/sensitiveReads.ts";
import { KIN_OWNER_LEVEL, seenBy } from "../work/teamView.ts";

const CONNECTION_LIMIT = 30;
const connectionStates = {
  active: "signed in",
  needs_sign_in: "needs signing in again",
  needs_review: "needs a look in Settings › Connections",
  error: "needs a look in Settings › Connections",
};

export interface NowState {
  readonly at: string;
  readonly lines: ReadonlyArray<string>;
}

export const RoutineHasNowState = Context.Reference("t3/kin/pulse/nowState/RoutineHasNowState", {
  defaultValue: () => false,
});

const recordKey = Schema.is(KinRecordKey);
const encodeKeys = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(KinRecordKey)));
const oneLine = (text: string) => text.trim().replace(/\s+/g, " ");

export const readNowState = Effect.fn("KinNowState.read")(function* (input: {
  readonly orgId: KinOrgId;
  readonly owner: KinPersonId;
  readonly at: number;
  readonly zone: string;
  readonly links: ReadonlyArray<string>;
  readonly wakeupId?: string;
  readonly pulseRecords?: ReadonlyArray<KinRecordId>;
}) {
  const { orgId, owner } = input;
  const sql = yield* SqlClient.SqlClient;
  const connections = yield* sql<{
    label: string;
    account: string | null;
    state: keyof typeof connectionStates;
    pausedAt: number | null;
    total: number;
  }>`SELECT label, account_label AS account, state, paused_at AS "pausedAt",
      COUNT(*) OVER () AS total
    FROM kin_connections WHERE org_id = ${orgId} AND removed_at IS NULL
      AND (person_id IS NULL OR person_id = ${owner})
    ORDER BY label, connection_id LIMIT ${CONNECTION_LIMIT}`;
  const lines = connections.map(({ label, account, state, pausedAt }) => {
    const name = oneLine(label);
    const address = oneLine(account ?? "");
    const subject = address === "" || address === name ? name : `${name} (${address})`;
    return `${subject}: ${pausedAt === null ? connectionStates[state] : "paused"}`;
  });
  const more = (connections[0]?.total ?? 0) - connections.length;
  if (more > 0) lines.push(`and ${more} more connections`);

  const keys = [...new Set(input.links.filter(recordKey))];
  const records =
    keys.length === 0
      ? []
      : yield* sql<Pick<RecordRow, "key" | "title" | "state"> & { sensitiveNow: number }>`
          SELECT key, title, state, "sensitiveNow"
          FROM (${selectRecords(sql, sql`, ${sensitiveNow(sql)} AS "sensitiveNow"`)}
            WHERE r.org_id = ${orgId}
              AND r.key IN (SELECT value FROM json_each(${yield* encodeKeys(keys)}))
              AND ${seenBy(sql, KIN_OWNER_LEVEL)})
          ORDER BY key`;
  if (input.wakeupId !== undefined && records.some((record) => record.sensitiveNow === 1))
    yield* sensitiveShown({ orgId, wakeupId: input.wakeupId });
  const pulseRecords = input.pulseRecords ?? [];
  const pulls =
    pulseRecords.length === 0
      ? []
      : yield* sql<{ link: string }>`SELECT DISTINCT l.target AS link
          FROM kin_records r JOIN kin_record_links l ON l.org_id = r.org_id AND l.record_id = r.record_id
          WHERE r.org_id = ${orgId} AND l.kind = 'pull_request'
            AND r.record_id IN ${sql.in(pulseRecords)} AND ${seenBy(sql, KIN_OWNER_LEVEL)}
          ORDER BY link`;
  const refs = new Map<string, { link: string; name: string }>();
  for (const link of [...input.links, ...pulls.map((pull) => pull.link)]) {
    const ref = githubRef(link);
    if (ref === undefined) continue;
    const name = `${ref.repo}#${ref.number}`;
    if (!refs.has(name.toLowerCase())) refs.set(name.toLowerCase(), { link, name });
  }
  const github = [...refs.values()];
  if (github.length > 0) {
    const states = yield* readGithubLinkSets(
      orgId,
      github.map(({ link }) => [link]),
    );
    for (const [index, { link, name }] of github.entries()) {
      const state = states[index]?.[0];
      if (state === undefined) {
        lines.push(`${link}: Kin couldn't check it now`);
        continue;
      }
      const author = state.author === undefined ? "" : ` by ${state.author}`;
      const assigned =
        state.assignees.length === 0 ? "" : `, assigned to ${state.assignees.join(", ")}`;
      lines.push(`${name}${author}: ${state.state}${assigned}`);
    }
  }
  for (const { key, title, state } of records) lines.push(`${key} ${oneLine(title)}: ${state}`);
  return {
    at: formatKinWhen(input.at, "dayTime", { zone: input.zone, locale: KIN_TEXT_LOCALE }),
    lines,
  } satisfies NowState;
});
