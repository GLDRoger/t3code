import { KinMessageId } from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import { KinChatHub } from "../chat/KinChatHub.ts";
import * as KinChatRepository from "../chat/KinChatRepository.ts";
import * as Memory from "../memory/Memory.ts";
import { CHIEF_OF_STAFF_DOMAIN, liveLead } from "./orgLeads.ts";

/**
 * Memory's notices for the owner, in one chat: theirs with the Chief of staff, else the first
 * lead's. Only a notice that needs the owner pushes and counts as unread.
 */
export const layer = Layer.effect(
  Memory.MemoryRecoveryHooks,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const chat = yield* KinChatRepository.KinChatRepository;
    const hub = yield* Effect.serviceOption(KinChatHub);
    return Memory.MemoryRecoveryHooks.of({
      notify: Effect.fn("KinMemoryRecovery.notify")(
        function* (notice) {
          yield* Effect.logWarning("Kin memory recovery requires operator attention", notice);
          const lead = yield* liveLead(sql, notice.orgId, { prefer: CHIEF_OF_STAFF_DOMAIN });
          if (lead === undefined) return;
          const message = yield* chat.insertMessage({
            orgId: notice.orgId,
            chatId: lead.ownerChatId,
            messageId: KinMessageId.make(`kin-memory:${SecureRandom.uuidV4Unsafe()}`),
            author: { _tag: "system" },
            kind: "text",
            body: notice.reason,
            intent: null,
            mentions: [],
            replyTo: null,
            widgetId: null,
            floorRunId: null,
            status: "posted",
            sentBy: null,
            clientMessageId: null,
            createdAt: DateTime.formatIso(yield* DateTime.now),
            editedAt: null,
            ...(notice.needsOwner === true ? {} : { silent: true as const }),
          });
          if (Option.isSome(hub))
            yield* hub.value.publish({ type: "message.posted", orgId: notice.orgId, message });
        },
        Effect.catchCause((cause) => Effect.logError("Kin memory owner notice failed", cause)),
      ),
    });
  }),
);
