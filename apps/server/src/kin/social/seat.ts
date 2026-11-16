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
    // The lead's own thread only: a shared chat's turn (chat_id set) never carries them.
    const rows = yield* sql<{ domain: string }>`SELECT l.domain FROM kin_agent_threads t
      JOIN kin_leads l ON l.org_id = t.org_id AND l.agent_id = t.agent_id
      WHERE t.thread_id = ${threadId} AND t.ended_at IS NULL AND t.chat_id IS NULL
      ORDER BY t.thread_id LIMIT 1`;
    return rows[0] !== undefined && laneOf(rows[0].domain) === "social";
  },
  Effect.orElseSucceed(() => false),
);
