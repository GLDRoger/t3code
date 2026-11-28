import type { KinMessageId, KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import { KinChatHub } from "./KinChatHub.ts";
import { KinChatRepository } from "./KinChatRepository.ts";

export const replaceSystemNotice = Effect.fn("KinChat.replaceSystemNotice")(function* (input: {
  readonly orgId: KinOrgId;
  readonly messageId: KinMessageId;
  readonly before: string;
  readonly body: string;
  readonly at: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* KinChatRepository;
  const hub = yield* Effect.serviceOption(KinChatHub);
  const { orgId, messageId, before, body, at } = input;
  const updated = yield* sql`UPDATE kin_messages SET body = ${body}, edited_at = ${at}
    WHERE org_id = ${orgId} AND message_id = ${messageId}
      AND author_kind = 'system' AND kind = 'system' AND status = 'posted' AND body = ${before}
    RETURNING message_id`;
  if (updated.length === 0) return;
  const message = yield* repo.getMessage(input);
  if (Option.isSome(hub) && Option.isSome(message))
    yield* sql.afterCommit(
      hub.value.publish({ type: "message.changed", orgId, message: message.value }),
    );
});
