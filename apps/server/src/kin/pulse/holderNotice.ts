// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous retry-key hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";
import {
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
import { HELD_ID } from "../triggers/heldDelivery.ts";
import { holdFor, holdLine } from "../triggers/quietHold.ts";
import { daysAgoText, type SenseContext } from "./senses/shared.ts";

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
  fact: Pick<KinPulseFact, "sense" | "subject">,
  dueAt: number,
) => {
  const when = daysAgoText(ctx, dueAt);
  const state = fact.sense === "task_due_soon" ? "due today" : `was due ${when}`;
  return { key: fact.subject.key, title: fact.subject.title, state };
};

/** What the holder reads, and their push says: one sentence for one fact, else a short list. */
export const holderBody = (lines: ReadonlyArray<ReturnType<typeof holderLine>>) => {
  if (lines.length === 1) {
    const [one] = lines;
    return `${one!.key} ${one!.title} ${one!.state}.`;
  }
  const rest = lines.length - SHOWN;
  return [
    `${lines.length} of your tasks need you:`,
    ...lines.slice(0, SHOWN).map((one) => `• ${one.key} ${one.title}, ${one.state}`),
    ...(rest > 0 ? [`and ${rest} more`] : []),
  ].join("\n");
};

/**
 * Posts Kin's notice of `facts` in the person's direct chat with `agentId` (else the team agent,
 * as assignment notices pick), opened if needed; in their quiet hours or while away it is held
 * until they are back. Returns the id the told rows carry, or undefined when no chat may hold it.
 */
export const tellHolder = Effect.fn("KinPulse.tellHolder")(function* (input: {
  readonly ctx: SenseContext;
  readonly personId: KinPersonId;
  readonly agentId: KinAgentId;
  readonly facts: ReadonlyArray<KinPulseFact>;
}) {
  const { ctx, personId } = input;
  const { orgId } = ctx;
  const chats = yield* Effect.serviceOption(KinChatService);
  if (Option.isNone(chats) || input.facts.length === 0) return undefined;
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
    const due = fact.subject.recordId === undefined ? undefined : dueOf.get(fact.subject.recordId);
    return due === undefined ? [] : [holderLine(ctx, fact, due)];
  });
  if (lines.length === 0) return undefined;
  const via = (yield* LeadAccess.allowed({ orgId, agentId: input.agentId, personId }))
    ? input.agentId
    : yield* LeadAccess.teamAgent(orgId);
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
  const body = holderBody(lines);
  // The same facts for the same person are one message, so a retried pass posts nothing more.
  const messageId = KinMessageId.make(
    `${HOLDER_ID}${NodeCrypto.createHash("sha256")
      .update(`${orgId}\0${personId}\0${input.facts.map((fact) => fact.key).join("\0")}`)
      .digest("hex")
      .slice(0, 32)}`,
  );
  const held = yield* holdFor({ orgId, personId, chatId });
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
    .notice({ orgId, chatId, messageId, audience: "chat", body })
    .pipe(
      Effect.as(true),
      Effect.catch((cause) =>
        Effect.logWarning("Kin couldn't tell a holder", { orgId, cause }).pipe(Effect.as(false)),
      ),
    );
  return posted ? messageId : undefined;
});
