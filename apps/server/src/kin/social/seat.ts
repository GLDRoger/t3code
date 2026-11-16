import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { laneOf } from "../team/stakes.ts";

/**
 * Whether a lead thread belongs to an agent whose remit is social media: only its turns carry
 * Social's tools, so every other agent's prompt stays short.
 */
export const socialSeatThread = Effect.fn("KinSocial.seatThread")(
  function* (threadId: ThreadId) {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ domain: string }>`SELECT l.domain FROM kin_leads l
      WHERE l.thread_id = ${threadId} ORDER BY l.agent_id LIMIT 1`;
    return rows[0] !== undefined && laneOf(rows[0].domain) === "social";
  },
  Effect.orElseSucceed(() => false),
);
