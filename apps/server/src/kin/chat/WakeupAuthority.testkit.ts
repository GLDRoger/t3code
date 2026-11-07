import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export const seedWakeupRun = Effect.fn("test.seedWakeupRun")(function* (
  threadId: ThreadId,
  runId = "authority-run",
  providerSessionId = "provider-session",
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO orchestration_v2_projection_provider_threads
    (provider_thread_id, thread_id, provider, provider_session_id, status, updated_at, payload_json)
    VALUES (${runId}, ${threadId}, 'codex', ${providerSessionId}, 'running', '1970-01-01T00:00:00.000Z', '{}')`;
  yield* sql`INSERT INTO orchestration_v2_projection_runs
    (run_id, thread_id, ordinal, provider, provider_thread_id, status, requested_at, payload_json)
    SELECT ${runId}, ${threadId}, COALESCE(MAX(ordinal), 0) + 1, 'codex', ${runId}, 'running', '1970-01-01T00:00:00.000Z', '{}' FROM orchestration_v2_projection_runs WHERE thread_id = ${threadId}`;
});
