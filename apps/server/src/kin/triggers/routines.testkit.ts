import { KinOrgId, KinMemoryItemId, MemoryItemHead } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as Memory from "../memory/Memory.ts";
import * as Chat from "../chat/KinChatService.ts";
import * as JudgeShadow from "../floor/JudgeShadow.ts";
import * as Repository from "../chat/KinChatRepository.ts";
import * as Hub from "../chat/KinChatHub.ts";
import * as Persistence from "../persistence/KinPersistence.ts";
import * as EventQueue from "../lead/KinEventQueue.ts";
import * as TriggerStore from "./KinTriggerStore.ts";
import * as TriggerInbox from "./KinTriggerInbox.ts";
import * as TriggerScheduler from "./KinTriggerScheduler.ts";
import * as Routines from "./routines.ts";
import * as OwnerCheck from "./ownerCheck.ts";

export const orgId = KinOrgId.make("a");
export const otherOrg = KinOrgId.make("b");
const timestamp = "2026-11-07T00:00:00.000Z";
const decodeHead = Schema.decodeUnknownSync(MemoryItemHead);
export const item = (id: string, overrides: Partial<MemoryItemHead> = {}) =>
  decodeHead({
    orgId,
    id: KinMemoryItemId.make(id),
    path: `claims/${id}.md`,
    kind: "claim",
    title: id,
    status: "open",
    due: null,
    recorded_at: "2026-09-01",
    valid_from: "2026-09-01",
    invalid_at: null,
    superseded_by: null,
    review_by: "2026-12-01",
    source: "owner-chat",
    said_by: "owner",
    trust: "owner",
    links: ["https://example.com/evidence"],
    ...overrides,
  });
export function fixture(
  items: ReadonlyArray<MemoryItemHead> = [],
  options: {
    query?: (sql: SqlClient.SqlClient) => Memory.Memory["Service"]["query"];
    register?: Scheduler.Scheduler["Service"]["register"];
  } = {},
) {
  const database = Persistence.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));
  const repositories = Layer.mergeAll(
    Repository.layer,
    TriggerStore.layer,
    TriggerInbox.layer,
    EventQueue.layer,
  ).pipe(
    Layer.provideMerge(database),
    Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
  );
  const dependencies = Layer.mergeAll(
    Layer.unwrap(
      Effect.map(SqlClient.SqlClient, (sql) =>
        Layer.mock(Memory.Memory)({
          query:
            options.query?.(sql) ??
            ((orgId) =>
              Effect.succeed(
                items
                  .filter((item) => item.orgId === orgId)
                  .map((item) => ({ ...item, duplicate: false })),
              )),
          readItemQuietly: (orgId, id) => {
            const head = items.find((item) => item.orgId === orgId && item.id === id);
            return head === undefined
              ? Effect.fail(new Memory.MemoryNotFound({ orgId, id }))
              : Effect.succeed({ head, body: "Body\n" });
          },
        }),
      ),
    ),
    Chat.layer.pipe(Layer.provide(JudgeShadow.layerOff), Layer.provideMerge(Hub.layer)),
    TriggerScheduler.layer,
  ).pipe(
    Layer.provideMerge(repositories),
    Layer.provide(
      Layer.succeed(Scheduler.Scheduler, { register: options.register ?? (() => Effect.void) }),
    ),
  );
  const owner = OwnerCheck.layer.pipe(Layer.provideMerge(dependencies));
  return Routines.layer.pipe(
    Layer.provideMerge(owner),
    Layer.provideMerge(
      Layer.succeed(Scheduler.Scheduler, { register: options.register ?? (() => Effect.void) }),
    ),
  );
}
export const seed = Effect.fn("test.routinesSeed")(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const org of [orgId, otherOrg]) {
    const agent = `lead-${org}`;
    yield* sql`INSERT INTO kin_orgs VALUES (${org}, 'Kin', ${timestamp})`;
    yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at) VALUES (${`owner-${org}`}, ${org}, 'owner', 'Owner', ${timestamp})`;
    yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at) VALUES (${agent}, ${org}, 'Lead', 'lead', ${`owner-${org}`}, ${timestamp})`;
    yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at) VALUES (${`chat-${org}`}, ${org}, 'direct', ${`direct-${org}`}, 0, ${timestamp})`;
    yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at) VALUES (${`owner-member-${org}`}, ${org}, ${`chat-${org}`}, 'person', ${`owner-${org}`}, 'owner', ${timestamp})`;
    yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, agent_id, role, joined_at) VALUES (${`lead-member-${org}`}, ${org}, ${`chat-${org}`}, 'agent', ${agent}, 'member', ${timestamp})`;
    yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json, worker_projects_json, owner_chat_id) VALUES (${agent}, ${org}, 'Lead', 0, '{}', '[]', ${`chat-${org}`})`;
  }
});
