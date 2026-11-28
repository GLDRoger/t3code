import {
  KinEvent,
  KinEventId,
  type KinAgentId,
  type KinChatId,
  type KinPersonId,
  type KinOrgId,
  type KinPulseOutsideLine,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous id hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";

import type { KinConnectionActivity, KinConnections } from "../connections/ConnectionsService.ts";
import * as KinShell from "../shell/KinShell.ts";
import { addressesIn } from "../connections/MailProvider.ts";
import { normalizeAddress, quietBankSenderAddresses } from "../work/statements/bankSenderRows.ts";
import { MAIL_PRESETS } from "../connections/mailProviders.ts";
import { agentQuietUntil, personQuietUntil } from "../triggers/quietHold.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import { logTouch } from "../work/touches.ts";
import { latestByThread } from "../arrivals/ArrivalStore.ts";
import { checkInMailMark } from "../arrivals/classify.ts";
import { CHIEF_OF_STAFF_DOMAIN, liveLead } from "../lead/orgLeads.ts";

type MailThread = { readonly connectionId: string; readonly threadId: string };

/** What is new at an org's connections since its last check-in, and the cursors that marks. */
export interface OutsideRead {
  readonly lines: ReadonlyArray<KinPulseOutsideLine>;
  /** Mailbox and untruncated provider thread ID for each fresh mail line. */
  readonly mailThreads?: ReadonlyMap<KinPulseOutsideLine, MailThread>;
  readonly seen: ReadonlyArray<{
    readonly connectionId: string;
    readonly until: number;
    readonly cursor?: string | null;
  }>;
}

/** The server's metadata reads of connections; no model runs and nothing is stored but cursors. */
export interface OutsideSource {
  readonly read: (orgId: KinOrgId) => Effect.Effect<OutsideRead>;
  /** Moves each cursor on, once a check-in carried what came before it. */
  readonly seen: (orgId: KinOrgId, seen: OutsideRead["seen"]) => Effect.Effect<void>;
}

const emptyRead: OutsideRead = { lines: [], seen: [] };

export const noOutside: OutsideSource = {
  read: () => Effect.succeed(emptyRead),
  seen: () => Effect.void,
};

const cut = (text: string | null | undefined, max: number) => {
  if (text == null) return null;
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
};
const isoOf = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

export const mailLine = (
  label: string,
  account: string | null,
  mail: Pick<
    Extract<KinConnectionActivity, { readonly _tag: "mail" }>["mail"][number],
    "receivedBy" | "threadId" | "date" | "from"
  > & { readonly subject: string | null },
): KinPulseOutsideLine => ({
  source: "mail",
  connection: cut(label, 120)!,
  ...(account === null ? {} : { account: cut(account, 320)! }),
  ...(mail.receivedBy === null ? {} : { to: cut(mail.receivedBy, 320)! }),
  id: cut(`${mail.threadId}:${mail.date ?? ""}`, 200)!,
  thread: cut(mail.threadId, 200)!,
  at: cut(mail.date, 60),
  who: cut(mail.from, 300),
  subject: cut(mail.subject, 300),
  where: null,
});

const calendarLines = (
  label: string,
  activity: Extract<KinConnectionActivity, { readonly _tag: "mail" }>,
): ReadonlyArray<KinPulseOutsideLine> => {
  const connection = cut(label, 120)!;
  return activity.calendar.map((event): KinPulseOutsideLine => ({
    source: "calendar",
    connection,
    ...(activity.account === null ? {} : { account: cut(activity.account, 320)! }),
    id: cut(`${event.eventId}:${event.updated ?? ""}`, 200)!,
    at: cut(event.updated, 60),
    who: null,
    subject: cut(
      `${event.summary ?? "(no title)"}${event.status === "cancelled" ? " (cancelled)" : ""}`,
      300,
    ),
    where: cut(event.start, 200),
  }));
};

/** What else a pass does with one mailbox's new mail (bank alerts): false when it couldn't. */
export type OnMail = (
  orgId: KinOrgId,
  activity: Extract<KinConnectionActivity, { readonly _tag: "mail" }>,
) => Effect.Effect<boolean>;

/** Every live connection that is signed in and not paused, through the connections service. */
export const fromConnections = (
  connections: KinConnections["Service"],
  sql: SqlClient.SqlClient,
  onMail?: OnMail,
): OutsideSource => ({
  read: Effect.fn("KinPulseOutside.read")(
    function* (orgId: KinOrgId) {
      const rows = yield* sql<{ connectionId: string; label: string }>`SELECT connection_id AS
        "connectionId", label FROM kin_connections
      WHERE org_id = ${orgId} AND removed_at IS NULL AND paused_at IS NULL AND state = 'active'
        AND preset IN ${sql.in(MAIL_PRESETS)} AND person_id IS NULL
      ORDER BY created_at, connection_id`;
      const money = yield* KinShell.sectionOnFor(orgId, "money").pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      );
      const mailboxes: Array<{
        connectionId: string;
        label: string;
        activity: Extract<KinConnectionActivity, { readonly _tag: "mail" }>;
      }> = [];
      const lines: Array<KinPulseOutsideLine> = [];
      const mailThreads = new Map<KinPulseOutsideLine, MailThread>();
      const seen: Array<{ connectionId: string; until: number; cursor: string | null }> = [];
      for (const row of rows) {
        const activity = yield* connections.activity(orgId, row.connectionId).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Kin pulse couldn't read a connection", {
              orgId,
              connectionId: row.connectionId,
              cause,
            }).pipe(Effect.as(undefined)),
          ),
        );
        if (activity === undefined || activity._tag === "unsupported") continue;
        // As with a failed read: the mailbox stays where it was, and the next pass reads it again.
        if (onMail !== undefined && !(yield* onMail(orgId, activity))) continue;
        mailboxes.push({ ...row, activity });
        seen.push({
          connectionId: row.connectionId,
          until: activity.until,
          cursor: activity._tag === "mail" ? activity.cursor : null,
        });
      }
      const hidden = yield* quietBankSenderAddresses(orgId, money).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      );
      for (const { connectionId, label, activity } of mailboxes) {
        for (const mail of activity.mail) {
          if (hidden.has(normalizeAddress(addressesIn(mail.from)[0]) ?? "")) continue;
          const line = mailLine(label, activity.account, mail);
          lines.push(line);
          mailThreads.set(line, { connectionId, threadId: mail.threadId });
        }
        lines.push(...calendarLines(label, activity));
      }
      return { lines, mailThreads, seen } satisfies OutsideRead;
    },
    Effect.catch((cause) =>
      Effect.logWarning("Kin pulse outside read failed", { cause }).pipe(Effect.as(emptyRead)),
    ),
  ),
  seen: (orgId, seen) =>
    Effect.forEach(
      seen,
      ({ connectionId, until, cursor }) =>
        connections
          .activitySeen(orgId, connectionId, until, cursor)
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Kin pulse couldn't move a connection cursor", { orgId, cause }),
            ),
          ),
      { discard: true },
    ),
});

/** First mail from someone Kin doesn't know wakes the Chief of staff, a few a poll at most. */
export const NEW_SENDERS_PER_POLL = 3;

interface PlaybookMatch {
  readonly line: KinPulseOutsideLine;
  /** Money threads go to Finance; client mail and meetings to the Chief of staff. */
  readonly domain: "finance" | "chief";
  /** The client whose contact wrote it: mail from a client is contact with that client. */
  readonly clientId?: string;
  readonly arrivalId?: string;
}

interface RuleMatch {
  readonly line: KinPulseOutsideLine;
  readonly more: ReadonlyArray<KinPulseOutsideLine>;
  readonly notListed: number;
  readonly arrivalId: string;
  readonly rule: {
    readonly ruleId: string;
    readonly manual?: true;
    readonly activation: number;
    readonly key: string;
    readonly agentId: KinAgentId;
    readonly chatId: KinChatId;
    readonly saidBy: KinPersonId;
  };
}

export type Matched = PlaybookMatch | RuleMatch;

/** Calendar matches for watches and check-ins. Mail is classified by the arrival feed. */
export const matchLines = Effect.fn("KinPulseOutside.match")(function* (
  orgId: KinOrgId,
  lines: ReadonlyArray<KinPulseOutsideLine>,
) {
  const sql = yield* SqlClient.SqlClient;
  if (lines.length === 0) return [];
  const meetings = yield* sql<{ key: string; title: string; registerId: string }>`SELECT key,
      title, register_id AS "registerId" FROM kin_records
    WHERE org_id = ${orgId} AND state IN ('open', 'doing', 'waiting')
      AND ((register_id = 'work' AND category = 'meeting') OR register_id = 'clients')
    ORDER BY key`;
  const matched: Array<Matched> = [];
  for (const line of lines) {
    if (line.source !== "calendar") continue;
    const subject = (line.subject ?? "").toLowerCase();
    const meeting =
      meetings.find(
        (row) =>
          row.registerId === "work" &&
          row.title.toLowerCase() === subject.replace(/ \(cancelled\)$/, ""),
      ) ??
      meetings.find(
        (row) =>
          row.registerId === "clients" &&
          row.title.length >= 3 &&
          subject.includes(row.title.toLowerCase()),
      );
    if (meeting !== undefined)
      matched.push({
        line: {
          ...line,
          matched: `${meeting.registerId === "work" ? "meeting" : "client"} ${meeting.key} ${meeting.title}`,
        },
        domain: "chief",
      });
  }
  return matched;
});

export const markMailLines = Effect.fn("KinPulseOutside.markMailLines")(function* (
  orgId: KinOrgId,
  lines: Iterable<KinPulseOutsideLine>,
  mailThreads: OutsideRead["mailThreads"],
) {
  if (mailThreads === undefined) return [];
  const byMailbox = new Map<string, Array<{ threadId: string; line: KinPulseOutsideLine }>>();
  for (const line of lines) {
    const mail = mailThreads.get(line);
    if (mail === undefined) continue;
    const group = byMailbox.get(mail.connectionId) ?? [];
    group.push({ threadId: mail.threadId, line });
    byMailbox.set(mail.connectionId, group);
  }
  const marked: KinPulseOutsideLine[] = [];
  for (const [connectionId, group] of byMailbox) {
    const arrivals = yield* latestByThread(
      orgId,
      connectionId,
      group.map(({ threadId }) => threadId),
    );
    for (const { threadId, line } of group) {
      const arrival = arrivals.get(threadId);
      const matched = arrival === undefined ? undefined : checkInMailMark(arrival);
      if (matched !== undefined) marked.push({ ...line, matched });
    }
  }
  return marked;
});

const decodeEvent = Schema.decodeUnknownEffect(KinEvent);
const shortHash = (text: string) =>
  NodeCrypto.createHash("sha256").update(text).digest("hex").slice(0, 32);

export const outsideKey = (line: KinPulseOutsideLine) =>
  `outside:${shortHash(`${line.connection}\0${line.source}\0${line.id}`)}`;

/**
 * Between check-ins: processes bank alerts and wakes an agent once per calendar watch match.
 * The cursors stay where the last check-in left them, so unsettled mail can reach the next one.
 */
export const poll = Effect.fn("KinPulseOutside.poll")(function* (
  orgId: KinOrgId,
  at: number,
  source: OutsideSource,
) {
  const { lines } = yield* source.read(orgId);
  const matched = yield* matchLines(
    orgId,
    lines.filter((line) => line.source === "calendar"),
  );
  return (yield* wakeMatches(orgId, at, matched)).map((wake) => wake.lineId);
});

export const wakeMatches = Effect.fn("KinPulseOutside.wakeMatches")(function* (
  orgId: KinOrgId,
  at: number,
  matched: ReadonlyArray<Matched>,
) {
  const sql = yield* SqlClient.SqlClient;
  const queue = yield* KinEventQueue.KinEventQueue;
  if (matched.length === 0) return [];
  const playbook = matched.some((match) => "domain" in match);
  const chief = playbook
    ? yield* liveLead(sql, orgId, { prefer: CHIEF_OF_STAFF_DOMAIN })
    : undefined;
  const [finance] = matched.some((match) => "domain" in match && match.domain === "finance")
    ? yield* sql<{ agentId: KinAgentId }>`SELECT l.agent_id AS "agentId"
    FROM kin_leads l JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
      AND a.role = 'lead' AND a.retired_at IS NULL
    WHERE l.org_id = ${orgId} AND l.domain = 'finance' ORDER BY a.created_at, l.agent_id LIMIT 1`
    : [];
  const woke: Array<{ lineId: string; eventId: KinEventId }> = [];
  for (const match of matched) {
    const { line, arrivalId } = match;
    const agentId =
      "rule" in match
        ? match.rule.agentId
        : match.domain === "finance"
          ? (finance?.agentId ?? chief?.agentId)
          : chief?.agentId;
    if (agentId === undefined) continue;
    const key = "rule" in match ? match.rule.key : outsideKey(line);
    if ("clientId" in match && match.clientId !== undefined) {
      const sent = line.at === null ? Number.NaN : Date.parse(line.at);
      yield* logTouch(orgId, {
        partyId: match.clientId,
        kind: "email",
        at: Number.isFinite(sent) && sent >= 0 ? Math.min(sent, at) : at,
        note: (line.subject ?? "").slice(0, 300),
        personId: null,
        by: { kind: "agent", id: agentId },
        originKey: `mail-in:${key}`,
        now: at,
      }).pipe(
        Effect.catch((cause) => Effect.logWarning("Kin couldn't note client mail", { cause })),
      );
    }
    const eventId = KinEventId.make(`pulse-${shortHash(`${orgId}\0${key}`)}`);
    const notBefore =
      "rule" in match
        ? yield* personQuietUntil(orgId, match.rule.saidBy, at)
        : yield* agentQuietUntil(orgId, agentId, at);
    const queued = yield* queue
      .enqueue(
        yield* decodeEvent({
          _tag: "pulse",
          orgId,
          eventId,
          agentId,
          receivedAt: isoOf(at),
          dedupeKey: key,
          provenance: { _tag: "system" },
          factKeys: [],
          outside: "rule" in match ? [line, ...match.more] : [line],
          ...(arrivalId === undefined ? {} : { arrivalId }),
          ...("rule" in match
            ? {
                chatId: match.rule.chatId,
                rule: {
                  ruleId: match.rule.ruleId,
                  activation: match.rule.activation,
                  ...(match.rule.manual === true ? { manual: true } : {}),
                },
                ...(match.notListed > 0 ? { outsideNotListed: match.notListed } : {}),
              }
            : {}),
        }),
        notBefore === undefined ? undefined : { notBefore },
      )
      .pipe(
        Effect.map((result) => !result.duplicate),
        Effect.catchTags({
          KinEventQueueUnknownAgent: () => Effect.succeed(false),
          KinEventQueueRetiredAgent: () => Effect.succeed(false),
          KinEventQueueConflict: () => Effect.succeed(false),
        }),
      );
    if (queued) woke.push({ lineId: line.id, eventId });
  }
  return woke;
});
