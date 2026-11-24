import { KinChatError, KinEvent, type KinOrgId } from "@t3tools/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous id hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { KinEventQueue } from "../lead/KinEventQueue.ts";
import type { waitingOnCountry } from "./companyProfile.ts";

const decodeEvent = Schema.decodeUnknownEffect(KinEvent);
const hashOf = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
const notNow = new KinChatError({
  reason: "conflict",
  message: "The company details couldn't be saved just now, so nothing changed. Try again.",
});

/**
 * The first country a new company saves: each agent a write was refused for want of it is woken
 * once, in the chat it was refused in, with the country and its currency (`countryChosenLine`).
 */
export const wakeRefused = Effect.fn("KinCountryWake.wakeRefused")(function* (
  orgId: KinOrgId,
  waiting: Effect.Success<ReturnType<typeof waitingOnCountry>>["waiting"],
  country: string,
  currency: string,
) {
  if (waiting.length === 0) return;
  const sql = yield* SqlClient.SqlClient;
  const queue = yield* KinEventQueue;
  const now = yield* Clock.currentTimeMillis;
  for (const one of waiting) {
    const [lead] = yield* sql<{ ownerChatId: string }>`SELECT owner_chat_id AS "ownerChatId"
      FROM kin_leads WHERE org_id = ${orgId} AND agent_id = ${one.agentId}`;
    if (lead === undefined) continue;
    const dedupeKey = `country-chosen:${one.agentId}:${one.chatId}`;
    const event = yield* decodeEvent({
      _tag: "deferral.due",
      eventId: `country_${hashOf(`${orgId}\0${dedupeKey}`).slice(0, 32)}`,
      orgId,
      agentId: one.agentId,
      receivedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
      provenance: { _tag: "system" },
      dedupeKey,
      subject: { type: "country", country, currency },
      lateByMs: 0,
      askedIn: [one.wakeupId],
      ...(lead.ownerChatId === one.chatId
        ? {}
        : {
            chatId: one.chatId,
            origin: {
              agentId: one.agentId,
              chatId: one.chatId,
              ...(one.personId === undefined ? {} : { personId: one.personId }),
            },
          }),
    }).pipe(Effect.orDie);
    // A retired agent has no turn to wake; anything else rolls the save back.
    yield* queue.enqueue(event).pipe(
      Effect.catchTags({
        KinEventQueueRetiredAgent: () => Effect.void,
        KinEventQueueUnknownAgent: () => Effect.void,
      }),
      Effect.mapError(() => notNow),
    );
  }
});
