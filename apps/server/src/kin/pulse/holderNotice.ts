// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous retry-key hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";
import {
  formatKinWhen,
  KIN_TEXT_LOCALE,
  KinChatId,
  KinMessageId,
  type KinAgentId,
  type KinOrgId,
  type KinPersonId,
  type KinPulseFact,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import { KinChatService } from "../chat/KinChatService.ts";
import * as LeadAccess from "../lead/LeadAccess.ts";
import * as Reach from "../lead/Reach.ts";
import { noteAbout } from "../push/pushAbout.ts";
import { HELD_ID } from "../triggers/heldDelivery.ts";
import { holdFor, holdLine } from "../triggers/quietHold.ts";
import { daysAgoText, type SenseContext } from "./senses/shared.ts";
import { entryDueSoon } from "./told.ts";

const SHOWN = 5;
const HOLDER_ID = "kin-holder-";

/** Whether `messageId` is a holder notice, posted now or after being held (`deliverHeld`). */
export const isHolderNotice = Effect.fn("KinPulse.isHolderNotice")(function* (
  orgId: KinOrgId,
  messageId: KinMessageId,
) {
  if (messageId.startsWith(HOLDER_ID)) return true;
  if (!messageId.startsWith(HELD_ID)) return false;
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`SELECT 1 FROM kin_held_posts
    WHERE org_id = ${orgId} AND hold_id = ${messageId.slice(HELD_ID.length)}
      AND substr(kind, 1, ${HOLDER_ID.length}) = ${HOLDER_ID}
    LIMIT 1`;
  return rows.length > 0;
});

/** One fact's line: "W-8 Send the deck, was due yesterday". */
export const holderLine = (
  ctx: SenseContext,
  fact: Pick<KinPulseFact, "sense" | "subject" | "scope"> & { readonly lateReminder?: string },
  dueAt: number,
) => {
  const when = daysAgoText(ctx, dueAt);
  // What a client owes the holder says whose it is, so it never reads as the holder's own lateness.
  const client = fact.sense === "theirs_late" ? fact.scope.clientTitle : undefined;
  const from = client === undefined ? "" : ` from ${client}`;
  const state = fact.sense === "task_due_soon" ? "due today" : `was due${from} ${when}`;
  return {
    key: fact.subject.key,
    title: fact.subject.title,
    state,
    ...(fact.lateReminder === undefined ? {} : { reminder: fact.lateReminder }),
  };
};

/** A list section's entry: "BK-3 Room 4 was due 2026-11-19, yesterday", or off its check. */
export const entryLine = (
  fact: Pick<KinPulseFact, "sense" | "key" | "subject" | "consequence"> & {
    readonly lateReminder?: string;
  },
) => ({
  key: fact.subject.key,
  title: fact.subject.title,
  state: entryDueSoon(fact)
    ? "due today"
    : `${fact.consequence.charAt(0).toLowerCase()}${fact.consequence.slice(1).replace(/\.$/, "")}`,
  ...(fact.lateReminder === undefined ? {} : { reminder: fact.lateReminder }),
  entry: true as const,
});

/** What the holder's view hides, such as "Only me": counted, never named, as an agent reads it. */
const privateLine = (unnamed: ReadonlyArray<Pick<KinPulseFact, "sense">>) => {
  const today = unnamed.filter((fact) => fact.sense === "task_due_soon").length;
  const late = unnamed.length - today;
  const some = (n: number) => `${n} private ${n === 1 ? "task" : "tasks"} of yours`;
  const be = (n: number) => (n === 1 ? "is" : "are");
  const state =
    late > 0 && today > 0
      ? `${some(late)} ${be(late)} late and ${today} ${be(today)} due today`
      : late > 0
        ? `${some(late)} ${be(late)} late`
        : `${some(today)} ${be(today)} due today`;
  return `${state}. Open Tasks to see ${unnamed.length === 1 ? "it" : "them"}.`;
};

/**
 * What the holder reads, and their push says: one sentence for one fact, else a short list, then
 * a count of the private ones.
 */
export const holderBody = (
  lines: ReadonlyArray<ReturnType<typeof holderLine> & { readonly entry?: true }>,
  unnamed: ReadonlyArray<Pick<KinPulseFact, "sense">> = [],
) => {
  const rest = lines.length - SHOWN;
  const named =
    lines.length === 0
      ? []
      : lines.length === 1
        ? [
            `${lines[0]!.key} ${lines[0]!.title} ${lines[0]!.state}.${lines[0]!.reminder === undefined ? "" : ` ${lines[0]!.reminder}`}`,
          ]
        : [
            lines.some((one) => one.entry === true)
              ? `${lines.length} things need you:`
              : `${lines.length} of your tasks need you:`,
            ...lines
              .slice(0, SHOWN)
              .map(
                (one) =>
                  `• ${one.key} ${one.title}, ${one.state}${one.reminder === undefined ? "" : `. ${one.reminder}`}`,
              ),
            ...(rest > 0 ? [`and ${rest} more`] : []),
          ];
  return [...named, ...(unnamed.length === 0 ? [] : [privateLine(unnamed)])].join("\n");
};

/**
 * Posts Kin's notice of `facts`, and a count of `unnamed`, in the person's direct chat with
 * `agentId` (else the team agent, as assignment notices pick), opened if needed; in their quiet
 * hours or while away it is held until they are back. Returns the id the told rows carry, or
 * undefined when no chat may hold it.
 */
export const tellHolder = Effect.fn("KinPulse.tellHolder")(function* (input: {
  readonly ctx: SenseContext;
  readonly personId: KinPersonId;
  readonly agentId: KinAgentId;
  readonly facts: ReadonlyArray<KinPulseFact & { readonly lateReminder?: string }>;
  readonly unnamed: ReadonlyArray<KinPulseFact>;
}) {
  const { ctx, personId } = input;
  const { orgId } = ctx;
  const chats = yield* Effect.serviceOption(KinChatService);
  if (Option.isNone(chats) || input.facts.length + input.unnamed.length === 0) return undefined;
  const sql = yield* SqlClient.SqlClient;
  const ids = input.facts.flatMap((fact) =>
    fact.subject.recordId === undefined ? [] : [fact.subject.recordId],
  );
  const dueOf = new Map<string, number>();
  if (ids.length > 0)
    for (const row of yield* sql<{ recordId: string; dueAt: number }>`SELECT record_id AS
        "recordId", due_at AS "dueAt" FROM kin_records
      WHERE org_id = ${orgId} AND record_id IN ${sql.in(ids)} AND due_at IS NOT NULL
      ORDER BY record_id`)
      dueOf.set(row.recordId, row.dueAt);
  const lines = input.facts.flatMap((fact) => {
    if (fact.sense === "entry_late" || fact.sense === "entry_check") return [entryLine(fact)];
    const due = fact.subject.recordId === undefined ? undefined : dueOf.get(fact.subject.recordId);
    return due === undefined ? [] : [holderLine(ctx, fact, due)];
  });
  if (lines.length + input.unnamed.length === 0) return undefined;
  // One pass's facts for one person are one message, so a retried pass posts nothing more; a fact
  // open again after it cleared is told in a later pass, so it is a new message.
  const keys = [...input.facts, ...input.unnamed].map((fact) => fact.key);
  const noticeId = yield* noticeHolder({
    orgId,
    personId,
    agentId: input.agentId,
    body: holderBody(lines, input.unnamed),
    key: NodeCrypto.createHash("sha256")
      .update(`${orgId}\0${personId}\0${ctx.at}\0${keys.join("\0")}`)
      .digest("hex")
      .slice(0, 32),
  });
  // Its push stands while one of its facts does (`factsStand`); held, it waits on them too.
  if (noticeId !== undefined)
    yield* noteAbout(
      orgId,
      noticeId,
      keys.map((key) => `fact:${key}`),
    );
  return noticeId;
});

/** What the person a late promise was made to reads; its holder is told by their own notice. */
export const promisedLine = (input: {
  readonly key: string;
  readonly title: string;
  readonly holder: string;
  readonly day: string;
}) =>
  `${input.key} ${input.title}, which ${input.holder} promised you by ${input.day}, is late. Kin has told ${input.holder}.`;

/**
 * Posts Kin's notice of one late `fact` to the person it was promised to, as `tellHolder` posts a
 * holder's. Returns the id the told row carries, or undefined when no chat may hold it.
 */
export const tellPromised = Effect.fn("KinPulse.tellPromised")(function* (input: {
  readonly ctx: SenseContext;
  readonly personId: KinPersonId;
  readonly agentId: KinAgentId;
  readonly fact: KinPulseFact;
  readonly holder: string;
  readonly dueAt: number;
}) {
  const { ctx, personId, fact } = input;
  const noticeId = yield* noticeHolder({
    orgId: ctx.orgId,
    personId,
    agentId: input.agentId,
    body: promisedLine({
      key: fact.subject.key,
      title: fact.subject.title,
      holder: input.holder,
      day: formatKinWhen(input.dueAt, "day", { zone: ctx.zone, locale: KIN_TEXT_LOCALE }).replace(
        /,/g,
        "",
      ),
    }),
    key: NodeCrypto.createHash("sha256")
      .update(`promised\0${ctx.orgId}\0${personId}\0${ctx.at}\0${fact.key}`)
      .digest("hex")
      .slice(0, 32),
  });
  if (noticeId !== undefined) yield* noteAbout(ctx.orgId, noticeId, [`fact:${fact.key}`]);
  return noticeId;
});

/**
 * Posts `body` as Kin's notice to a holder, in their direct chat with `agentId` (else the team
 * agent, as assignment notices pick), opened if needed; in their quiet hours or while away it is
 * held until they are back. `key` names it, so a retry posts nothing more. Returns its message
 * id, or undefined when no chat may hold it.
 */
export const noticeHolder = Effect.fn("KinPulse.noticeHolder")(function* (input: {
  readonly orgId: KinOrgId;
  readonly personId: KinPersonId;
  readonly agentId: KinAgentId;
  readonly body: string;
  readonly key: string;
  /** Drawn as a page under the reader's greeting (`KinMessage.form`). */
  readonly form?: "brief";
  /** In their quiet hours, while away or outside their hours: post nothing, hold nothing. */
  readonly onlyIfFree?: true;
}) {
  const { orgId, personId, body } = input;
  const chats = yield* Effect.serviceOption(KinChatService);
  if (Option.isNone(chats)) return undefined;
  const sql = yield* SqlClient.SqlClient;
  // A restricted pair hears it from the team agent, if that may message them; else no chat.
  const via = yield* Reach.carrierFor(orgId, personId, input.agentId);
  if (via === null) return undefined;
  const [open] = yield* sql<{ chatId: string }>`SELECT c.chat_id AS "chatId" FROM kin_chats c
    JOIN kin_chat_members m ON m.org_id = c.org_id AND m.chat_id = c.chat_id
      AND m.principal_kind = 'person' AND m.person_id = ${personId} AND m.left_at IS NULL
    WHERE c.org_id = ${orgId} AND c.kind = 'direct'
      AND c.direct_key = ${LeadAccess.directKey(personId, via)}
    ORDER BY c.chat_id LIMIT 1`;
  const chatId =
    open !== undefined
      ? KinChatId.make(open.chatId)
      : yield* chats.value
          .createDirect({ _tag: "person", orgId, personId }, { orgId, agentId: via })
          .pipe(
            Effect.map((chat) => chat.chatId),
            Effect.orElseSucceed(() => undefined),
          );
  if (chatId === undefined) return undefined;
  const messageId = KinMessageId.make(`${HOLDER_ID}${input.key}`);
  const held = yield* holdFor({ orgId, personId, chatId });
  if (held !== undefined && input.onlyIfFree === true) return undefined;
  if (held !== undefined) {
    yield* holdLine({
      orgId,
      chatId,
      personId,
      key: messageId,
      body,
      audience: "chat",
      at: held.at,
    });
    return messageId;
  }
  const posted = yield* chats.value
    .notice({
      orgId,
      chatId,
      messageId,
      audience: "chat",
      body,
      ...(input.form === undefined ? {} : { form: input.form }),
    })
    .pipe(
      Effect.as(true),
      Effect.catch((cause) =>
        Effect.logWarning("Kin couldn't tell a holder", { orgId, cause }).pipe(Effect.as(false)),
      ),
    );
  return posted ? messageId : undefined;
});
