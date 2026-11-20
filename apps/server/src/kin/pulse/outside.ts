import {
  KinEvent,
  KinEventId,
  type KinAgentId,
  type KinOrgId,
  type KinPulseOutsideLine,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous id hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";

import { KinChatHub } from "../chat/KinChatHub.ts";
import { KinChatRepository } from "../chat/KinChatRepository.ts";
import type { KinConnectionActivity, KinConnections } from "../connections/ConnectionsService.ts";
import { MAIL_PRESETS } from "../connections/mailProviders.ts";
import { agentQuietUntil } from "../triggers/quietHold.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import { logTouch } from "../work/touches.ts";
import {
  type AlertCandidate,
  type AlertMailbox,
  noticeAlerts,
} from "../work/statements/bankAlerts.ts";
import { CHIEF_OF_STAFF_DOMAIN, liveLead } from "../lead/orgLeads.ts";

/** What is new at an org's connections since its last check-in, and the cursors that marks. */
export interface OutsideRead {
  readonly lines: ReadonlyArray<KinPulseOutsideLine>;
  /** The same mail as the bank alert rules read it: headers and the vendor's first lines. */
  readonly mail?: ReadonlyArray<AlertCandidate>;
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
  /** A confirmed bank sender's messages of a thread (`noticeAlerts`). */
  readonly alertMessages?: AlertMailbox;
}

export const noOutside: OutsideSource = {
  read: () => Effect.succeed({ lines: [], seen: [] }),
  seen: () => Effect.void,
};

const LINES_PER_CONNECTION = 50;
const cut = (text: string | null | undefined, max: number) =>
  text === null || text === undefined ? null : Array.from(text).slice(0, max).join("");
const isoOf = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

/** One connection's answer as lines: who, what, when, where. */
const linesOf = (
  label: string,
  activity: KinConnectionActivity,
): ReadonlyArray<KinPulseOutsideLine> => {
  const connection = cut(label, 120)!;
  switch (activity._tag) {
    case "mail":
      return [
        ...activity.mail.map((mail): KinPulseOutsideLine => ({
          source: "mail",
          connection,
          ...(activity.account === null ? {} : { account: cut(activity.account, 320)! }),
          ...(mail.receivedBy === null ? {} : { to: cut(mail.receivedBy, 320)! }),
          id: cut(`${mail.threadId}:${mail.date ?? ""}`, 200)!,
          at: cut(mail.date, 60),
          who: cut(mail.from, 300),
          subject: cut(mail.subject, 300),
          where: null,
        })),
        ...activity.calendar.map((event): KinPulseOutsideLine => ({
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
        })),
      ].slice(0, LINES_PER_CONNECTION);
    case "github":
      return activity.deliveries
        .slice(0, LINES_PER_CONNECTION)
        .map((delivery): KinPulseOutsideLine => ({
          source: "github",
          connection,
          id: cut(delivery.deliveryId ?? delivery.fireId, 200)!,
          at: isoOf(delivery.receivedAt),
          who: null,
          subject: cut(
            [delivery.eventName, delivery.summary].filter((part) => part !== null).join(": ") ||
              null,
            300,
          ),
          where: cut(delivery.repo, 200),
        }));
    case "unsupported":
      return [];
  }
};

/** Every live connection that is signed in and not paused, through the connections service. */
export const fromConnections = (
  connections: KinConnections["Service"],
  sql: SqlClient.SqlClient,
): OutsideSource => ({
  read: Effect.fn("KinPulseOutside.read")(
    function* (orgId: KinOrgId) {
      const rows = yield* sql<{ connectionId: string; label: string }>`SELECT connection_id AS
        "connectionId", label FROM kin_connections
      WHERE org_id = ${orgId} AND removed_at IS NULL AND paused_at IS NULL AND state = 'active'
        AND preset IN ${sql.in([...MAIL_PRESETS, "github"])}
      ORDER BY created_at, connection_id`;
      const lines: Array<KinPulseOutsideLine> = [];
      const mail: Array<AlertCandidate> = [];
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
        lines.push(...linesOf(row.label, activity));
        if (activity._tag === "mail")
          for (const one of activity.mail)
            mail.push({
              connectionId: row.connectionId,
              mailbox: activity.account,
              threadId: one.threadId,
              from: one.from,
              subject: one.subject,
              preview: one.preview ?? "",
              date: one.date,
            });
        seen.push({
          connectionId: row.connectionId,
          until: activity.until,
          cursor: activity._tag === "mail" ? activity.cursor : null,
        });
      }
      return { lines, mail, seen } satisfies OutsideRead;
    },
    Effect.catch((cause) =>
      Effect.logWarning("Kin pulse outside read failed", { cause }).pipe(
        Effect.as({ lines: [], seen: [] } satisfies OutsideRead),
      ),
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
  alertMessages: (orgId, connectionId, threadId, address) =>
    connections.alertMessages(orgId, connectionId, threadId, address),
});

const ADDRESS = /<([^<>\s]+@[^<>\s]+)>|([^\s<>,;"]+@[^\s<>,;"]+)/;
const addressOf = (who: string | null) => {
  const found = who === null ? null : ADDRESS.exec(who);
  return found === null ? undefined : (found[1] ?? found[2])!.toLowerCase();
};

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const AUTOMATED_SENDER =
  /^(?:no-?reply|do-?not-?reply|donotreply|notifications?|notify|mailer-daemon|postmaster|bounces?|news(?:letter)?|marketing|digest|alerts?|updates?)(?:[+._-]|@)/i;
const BULK_DOMAIN = /@(?:em|email|mail|mailer|bounce|news|newsletter|marketing|send|e)\d*\./i;
/**
 * A person writing to the company, as far as the sender line can tell: not an automated or bulk
 * sender, not the company's own domain, and sent to one of its connected addresses directly.
 */
const personToUs = (line: KinPulseOutsideLine, from: string | undefined) => {
  if (from === undefined || line.to === undefined) return false;
  if (AUTOMATED_SENDER.test(from) || BULK_DOMAIN.test(from)) return false;
  const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1);
  return domainOf(from) !== domainOf(line.to.toLowerCase());
};
/** First mail from someone Kin doesn't know wakes the Chief of staff, a few a poll at most. */
const NEW_SENDERS_PER_POLL = 3;

export interface Matched {
  readonly line: KinPulseOutsideLine;
  /** Money threads go to Finance; client mail and meetings to the Chief of staff. */
  readonly domain: "finance" | "chief";
  /** The client whose contact wrote it: mail from a client is contact with that client. */
  readonly clientId?: string;
}

/**
 * The playbook watches, as code over stored rows: mail from a client contact's address, mail
 * naming a sent invoice or quote, a person Kin doesn't know writing to the company, and a
 * calendar change to a meeting or a client Kin knows.
 */
export const matchLines = Effect.fn("KinPulseOutside.match")(function* (
  orgId: KinOrgId,
  lines: ReadonlyArray<KinPulseOutsideLine>,
) {
  const sql = yield* SqlClient.SqlClient;
  if (lines.length === 0) return [];
  const contacts = yield* sql<{
    email: string;
    key: string;
    title: string;
    clientId: string | null;
    clientKey: string | null;
    clientTitle: string | null;
    main: number;
  }>`SELECT lower(e.value) AS email, e.key = 'email' AS main, r.key, r.title,
      c.record_id AS "clientId", c.key AS "clientKey", c.title AS "clientTitle"
    FROM kin_records r
      JOIN (SELECT r2.record_id, 'email' AS key, json_extract(r2.fields_json, '$.email') AS value
          FROM kin_records r2 WHERE r2.org_id = ${orgId} AND r2.register_id = 'contacts'
        UNION ALL SELECT r2.record_id, 'emails', j.value
          FROM kin_records r2, json_each(r2.fields_json, '$.emails') j
          WHERE r2.org_id = ${orgId} AND r2.register_id = 'contacts') e
        ON e.record_id = r.record_id
      LEFT JOIN kin_records c ON c.org_id = r.org_id AND c.record_id = r.party_id
        AND c.register_id = 'clients'
    WHERE r.org_id = ${orgId} AND r.register_id = 'contacts' AND r.state = 'open'
      AND e.value IS NOT NULL
    ORDER BY main, r.key`;
  const money = yield* sql<{ key: string; list: string }>`SELECT key, register_id AS list
    FROM kin_records WHERE org_id = ${orgId} AND register_id IN ('invoices', 'quotes')
      AND state IN ('open', 'waiting')
    ORDER BY key`;
  const meetings = yield* sql<{ key: string; title: string; registerId: string }>`SELECT key,
      title, register_id AS "registerId" FROM kin_records
    WHERE org_id = ${orgId} AND state IN ('open', 'doing', 'waiting')
      AND ((register_id = 'work' AND category = 'meeting') OR register_id = 'clients')
    ORDER BY key`;
  // A contact's main address is matched as before; another one only where no main one has it.
  const byEmail = new Map(contacts.map((row) => [row.email, row]));
  const matched: Array<Matched> = [];
  let newSenders = 0;
  for (const line of lines) {
    const subject = (line.subject ?? "").toLowerCase();
    if (line.source === "mail") {
      const contact = byEmail.get(addressOf(line.who) ?? "");
      const named = money.find((row) =>
        new RegExp(`(^|[^a-z0-9-])${escaped(row.key.toLowerCase())}($|[^a-z0-9])`).test(subject),
      );
      const client = contact?.clientId == null ? {} : { clientId: contact.clientId };
      if (named !== undefined)
        matched.push({
          line: {
            ...line,
            matched: `${named.list === "invoices" ? "invoice" : "quote"} ${named.key}`,
          },
          domain: "finance",
          ...client,
        });
      else if (contact !== undefined)
        matched.push({
          line: {
            ...line,
            matched: `contact ${contact.key} ${contact.title}${contact.clientKey === null ? "" : ` of client ${contact.clientKey} ${contact.clientTitle ?? ""}`.trimEnd()}`,
          },
          domain: "chief",
          ...client,
        });
      else if (newSenders < NEW_SENDERS_PER_POLL && personToUs(line, addressOf(line.who))) {
        newSenders += 1;
        matched.push({
          line: { ...line, matched: "a sender Kin doesn't know yet: maybe a new enquiry" },
          domain: "chief",
        });
      }
    } else if (line.source === "calendar") {
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
  }
  return matched;
});

const decodeEvent = Schema.decodeUnknownEffect(KinEvent);
const shortHash = (text: string) =>
  NodeCrypto.createHash("sha256").update(text).digest("hex").slice(0, 32);

/**
 * Between check-ins: reads what is new, and wakes an agent once per item a watch matched. The
 * cursors stay where the last check-in left them, so the next check-in still lists everything.
 */
export const poll = Effect.fn("KinPulseOutside.poll")(function* (
  orgId: KinOrgId,
  at: number,
  source: OutsideSource,
) {
  const sql = yield* SqlClient.SqlClient;
  const queue = yield* KinEventQueue.KinEventQueue;
  const read = yield* source.read(orgId);
  const { lines } = read;
  // Kin's bank alert cards need the chat; a poll run without one notices none.
  const repo = yield* Effect.serviceOption(KinChatRepository);
  const hub = yield* Effect.serviceOption(KinChatHub);
  if (Option.isSome(repo) && Option.isSome(hub))
    yield* noticeAlerts(orgId, read.mail ?? [], at, source.alertMessages).pipe(
      Effect.provideService(KinChatRepository, repo.value),
      Effect.provideService(KinChatHub, hub.value),
      Effect.catchCause((cause) => Effect.logWarning("Kin couldn't notice bank alerts", { cause })),
    );
  const matched = yield* matchLines(orgId, lines);
  if (matched.length === 0) return [];
  const chief = yield* liveLead(sql, orgId, { prefer: CHIEF_OF_STAFF_DOMAIN });
  const [finance] = yield* sql<{ agentId: KinAgentId }>`SELECT l.agent_id AS "agentId"
    FROM kin_leads l JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
      AND a.role = 'lead' AND a.retired_at IS NULL
    WHERE l.org_id = ${orgId} AND l.domain = 'finance' ORDER BY a.created_at, l.agent_id LIMIT 1`;
  const woke: Array<string> = [];
  for (const { line, domain, clientId } of matched) {
    const agentId = domain === "finance" ? (finance?.agentId ?? chief?.agentId) : chief?.agentId;
    if (agentId === undefined) continue;
    const key = `outside:${shortHash(`${line.connection}\0${line.source}\0${line.id}`)}`;
    if (clientId !== undefined) {
      const sent = line.at === null ? Number.NaN : Date.parse(line.at);
      yield* logTouch(orgId, {
        partyId: clientId,
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
    const queued = yield* queue
      .enqueue(
        yield* decodeEvent({
          _tag: "pulse",
          orgId,
          eventId: KinEventId.make(`pulse-${shortHash(`${orgId}\0${key}`)}`),
          agentId,
          receivedAt: isoOf(at),
          dedupeKey: key,
          provenance: { _tag: "system" },
          factKeys: [],
          outside: [line],
        }),
        yield* heldUntil(orgId, agentId, at),
      )
      .pipe(
        Effect.map((result) => !result.duplicate),
        Effect.catchTags({
          KinEventQueueUnknownAgent: () => Effect.succeed(false),
          KinEventQueueRetiredAgent: () => Effect.succeed(false),
          KinEventQueueConflict: () => Effect.succeed(false),
        }),
      );
    if (queued) woke.push(line.id);
  }
  return woke;
});

/** A watch match nobody asked for waits out the owner's quiet hours. */
const heldUntil = (orgId: KinOrgId, agentId: KinAgentId, at: number) =>
  Effect.map(agentQuietUntil(orgId, agentId, at), (notBefore) =>
    notBefore === undefined ? undefined : { notBefore },
  );
