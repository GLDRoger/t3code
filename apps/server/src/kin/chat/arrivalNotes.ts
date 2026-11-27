import { KinMessageId, type KinMessage } from "@t3tools/contracts";
import type * as SqlClient from "effect/sql/SqlClient";

const PREFIX = "kin-arrives:";

export const arrivalNoteId = (key: string) => KinMessageId.make(`${PREFIX}${key}`);

export const isDismissedArrival = (message: KinMessage) =>
  message.author._tag === "system" &&
  message.status === "dismissed" &&
  message.messageId.startsWith(PREFIX);

export const dismissedArrivalSql = (sql: SqlClient.SqlClient) =>
  sql`(author_kind = 'system' AND status = 'dismissed'
    AND substr(message_id, 1, ${PREFIX.length}) = ${PREFIX})`;
