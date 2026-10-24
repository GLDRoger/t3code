import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

type KinHouseLineEvent = Extract<
  OrchestrationV2DomainEvent,
  { type: "kin.houseLine.crowned" | "kin.houseLine.will-recorded" }
>;

/** Runs inside the orchestration commit, so a replay writes the same rows. */
export const applyKinHouseLineEvent = Effect.fn("applyKinHouseLineEvent")(function* (
  sql: SqlClient.SqlClient,
  event: KinHouseLineEvent,
) {
  if (event.type === "kin.houseLine.crowned") {
    const payload = event.payload;
    yield* sql`
        INSERT INTO kin_house (id, project_id, name, agent_map_path)
        VALUES (${payload.houseId}, ${payload.projectId}, ${payload.houseName}, NULL)
        ON CONFLICT (id) DO NOTHING
      `;
    yield* sql`
        INSERT INTO kin_line (id, house_id, root_lane_id)
        VALUES (${payload.lineId}, ${payload.houseId}, ${payload.laneId})
        ON CONFLICT (id) DO NOTHING
      `;
    yield* sql`
        INSERT INTO kin_lane (
          id, project_id, house_id, label, thread_id, line_id, profile, role,
          crownable, sees_wills, provider, model, state, touched_paths_json,
          created_at, updated_at
        )
        VALUES (
          ${payload.laneId},
          ${payload.projectId},
          ${payload.houseId},
          ${payload.label},
          ${payload.threadId},
          ${payload.lineId},
          ${payload.profile},
          ${payload.role},
          1,
          1,
          ${payload.provider},
          ${payload.model},
          'running',
          '[]',
          ${payload.at},
          ${payload.at}
        )
        ON CONFLICT (id) DO UPDATE SET
          provider = excluded.provider,
          model = excluded.model,
          profile = excluded.profile,
          updated_at = excluded.updated_at
      `;
    yield* sql`
        INSERT INTO kin_crowning (
          id, lane_id, house_id, regnal_number, agent_profile, provider, model, crowned_at
        )
        VALUES (
          ${payload.crowningId},
          ${payload.laneId},
          ${payload.houseId},
          ${payload.regnalNumber},
          ${payload.profile},
          ${payload.provider},
          ${payload.model},
          ${payload.at}
        )
      `;
    return;
  }
  const payload = event.payload;
  yield* sql`
      INSERT INTO kin_will (id, crowning_id, body, written_at)
      VALUES (${payload.willId}, ${payload.crowningId}, ${payload.body}, ${payload.at})
    `;
  yield* sql`
      UPDATE kin_lane
      SET state = 'crowned', updated_at = ${payload.at}
      WHERE id = ${payload.laneId}
    `;
});
