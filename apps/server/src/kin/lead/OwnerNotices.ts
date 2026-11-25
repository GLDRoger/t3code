import { KinMessageId, kinTroubleWords } from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import { KinChatHub } from "../chat/KinChatHub.ts";
import * as KinChatRepository from "../chat/KinChatRepository.ts";
import * as Memory from "../memory/Memory.ts";
import { holdIfQuiet } from "../triggers/quietHold.ts";
import { CHIEF_OF_STAFF_DOMAIN, liveLead } from "./orgLeads.ts";

/** A restart cut an agent's turn after it noted something: which agent, and what to do. */
const restartNotice = (name: string) =>
  `${kinTroubleWords({ cause: "restart", agents: [{ name }], count: 0 }, String).what} Something it said it saved may not have been kept. If it matters, tell ${name} again.`;

/**
 * Memory's notices for the owner, in one chat: theirs with the Chief of staff, else the first
 * lead's. Only a notice with plain words for the owner is posted; its operator reason is logged.
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
          if (notice.owner === undefined) return;
          const lead = yield* liveLead(sql, notice.orgId, { prefer: CHIEF_OF_STAFF_DOMAIN });
          if (lead === undefined) return;
          const [agent] =
            notice.restartOf === undefined
              ? []
              : yield* sql<{ name: string }>`SELECT name FROM kin_leads
                  WHERE org_id = ${notice.orgId} AND agent_id = ${notice.restartOf}
                  ORDER BY agent_id`;
          const body = agent === undefined ? notice.owner : restartNotice(agent.name);
          // A night job's line waits out his quiet hours, merged with any others held for him.
          const held = yield* holdIfQuiet({
            orgId: notice.orgId,
            chatId: lead.ownerChatId,
            personId: lead.ownerPersonId,
            kind: "memory",
            body,
            audience: "owner",
          }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
          if (held) return;
          const message = yield* chat.insertMessage({
            orgId: notice.orgId,
            chatId: lead.ownerChatId,
            audience: "owner",
            messageId: KinMessageId.make(`kin-memory:${SecureRandom.uuidV4Unsafe()}`),
            author: { _tag: "system" },
            kind: "text",
            body,
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
          });
          if (Option.isSome(hub))
            yield* hub.value.publish({ type: "message.posted", orgId: notice.orgId, message });
        },
        Effect.catchCause((cause) => Effect.logError("Kin memory owner notice failed", cause)),
      ),
    });
  }),
);
