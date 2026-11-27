import { KinChatError, type KinOrgId, type KinPersonId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { mayActAsOwner } from "../people/KinAccess.ts";
import { orgOwner } from "./toolNames.ts";

export const onlyOwnerLevel = Effect.fn("KinMailSenderAccess.onlyOwnerLevel")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  message: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [active] = yield* sql`SELECT 1 FROM kin_people WHERE org_id = ${orgId}
    AND person_id = ${personId} AND removed_at IS NULL`;
  const owner = yield* orgOwner(orgId);
  if (
    active !== undefined &&
    owner !== null &&
    (yield* mayActAsOwner(orgId, personId, { personId: owner }))
  )
    return;
  return yield* new KinChatError({
    reason: "not_allowed",
    message,
  });
});
