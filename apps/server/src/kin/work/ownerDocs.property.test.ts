// Loaded first: the chat and trigger modules import each other.
import "../chat/KinChatService.ts";
import { assert, describe, it } from "@effect/vitest";
import {
  type KinDocsEvent,
  type KinDocsHeldPage,
  KinOrgId,
  KinPersonId,
  kinApplyDocsEvent,
  kinDocRowsStart,
  kinPatchDocsPage,
  type KinDocRows,
} from "@t3tools/contracts";
import * as Arbitrary from "effect/Arbitrary";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as Sqlite from "../../persistence/Sqlite.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import { KinLevelGate } from "../lead/LevelGate.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as Docs from "./docs.ts";
import * as KinRecords from "./KinRecords.ts";
import * as OwnerDocs from "./ownerDocs.ts";

// Docs' live stream with `acceptRows` (`ownerDocs.ts`): the Docs list page each viewer holds,
// patched from the stream with the client's own functions (`kinDocRows.ts`), equals a fresh read
// after every step of a history. Invented org, people and docs only.

const orgId = KinOrgId.make("org");
const ownerId = KinPersonId.make("owner");
const at = "2026-11-12T00:00:00.000Z";
const VIEWERS = ["owner", "mate"] as const;
type Viewer = (typeof VIEWERS)[number];
const peopleOf = (who: Viewer) => [
  { _tag: "person" as const, orgId, personId: KinPersonId.make(who) },
];

const identity = Layer.mock(KinIdentity)({
  owner: { _tag: "person" as const, orgId, personId: ownerId },
  isAgentThread: () => false,
  isLeadThread: () => false,
});
const testLayer = Layer.mergeAll(KinRecords.layer, identity, Layer.mock(KinLevelGate)({})).pipe(
  Layer.provideMerge(KinEventQueue.layer),
  Layer.provideMerge(KinPersistence.layer),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
);

const Pick = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 20 }));
const Op = Schema.Union([
  Schema.TaggedStruct("create", { shared: Schema.Boolean }),
  Schema.TaggedStruct("rewrite", { pick: Pick }),
  Schema.TaggedStruct("retitle", { pick: Pick }),
  Schema.TaggedStruct("archive", { pick: Pick, on: Schema.Boolean }),
  Schema.TaggedStruct("share", { pick: Pick, on: Schema.Boolean }),
  Schema.TaggedStruct("label", { pick: Pick, on: Schema.Boolean }),
  // A doc filed under the project, and the mate holding its task or being on it: no doc changes,
  // but the project's docs come into or leave her sight.
  Schema.TaggedStruct("projectDoc", {}),
  Schema.TaggedStruct("hold", { on: Schema.Boolean }),
  Schema.TaggedStruct("member", { on: Schema.Boolean }),
]);
type Op = typeof Op.Type;
const history = Arbitrary.array(Arbitrary.schema(Op), { minLength: 2, maxLength: 12 });
/** How many docs a screen read first: one, a page that leaves more, or everything. */
const firstPage = Arbitrary.schema(Schema.Literals([1, 2, 50]));

const SHELF = { orgId, archived: false, files: false, acceptSlimLatest: true } as const;

const docsCase = ([ops, limit]: readonly [ReadonlyArray<Op>, number]) =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const records = yield* KinRecords.KinRecords;
      yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Invented Co', ${at})`;
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access,
          sees_docs)
        VALUES (${ownerId}, ${orgId}, 'owner', 'Owner', ${at}, 'owner', 1),
          ('mate', ${orgId}, 'mate', 'Mate', ${at}, 'member', 1)`;
      // Change numbers are kept for teammates who have signed in.
      yield* sql`INSERT INTO kin_session_bindings (session_id, org_id, person_id, bound_at)
        VALUES ('session-mate', ${orgId}, 'mate', 0)`;
      const writer = { actor: { _tag: "person", personId: ownerId }, via: "owner" } as const;
      const project = yield* records.create(orgId, writer, {
        list: "projects",
        title: "Invented project",
        owner: { _tag: "person", personId: ownerId },
        originKey: "docs-property:project",
      });
      const task = yield* records.create(orgId, writer, {
        title: "Invented task on the project",
        owner: { _tag: "person", personId: ownerId },
        projectId: project.row.recordId,
        originKey: "docs-property:project-task",
      });
      let made = 0;
      const create = (shared: boolean, filed = false) =>
        Effect.gen(function* () {
          made += 1;
          const doc = yield* Docs.create(
            orgId,
            writer,
            {},
            {
              title: `Invented doc ${made}`,
              body: `# Invented doc ${made}\n\nFirst words.\n`,
              owner: { _tag: "person", personId: ownerId },
              summary: "Created",
              originKey: `docs-property:${made}`,
              ...(filed ? { projectId: project.row.recordId } : {}),
            },
          );
          if (shared) yield* records.update(orgId, writer, doc.row.key, { team: true });
        });
      for (const shared of [true, false, true]) yield* create(shared);
      const sentinel = yield* records.create(orgId, writer, {
        title: "Sentinel",
        owner: { _tag: "person", personId: ownerId },
        originKey: "docs-property:sentinel",
      });
      const pull = yield* Stream.toPull(records.changes(orgId));
      yield* pull;

      const read = (who: Viewer, want: number) =>
        OwnerDocs.list(peopleOf(who), { ...SHELF, limit: Math.max(1, want) });
      const screens = new Map<
        Viewer,
        {
          session: Effect.Success<ReturnType<typeof OwnerDocs.makeDocsStream>>;
          rows: KinDocRows;
          page: KinDocsHeldPage;
        }
      >();
      const reread = (who: Viewer, rows: KinDocRows, want: number) =>
        Effect.map(read(who, want), (fresh): KinDocsHeldPage => ({
          docs: fresh.docs,
          total: fresh.total,
          more: fresh.nextCursor !== null,
          seq: fresh.seq,
          epoch: rows.epoch,
        }));
      for (const who of VIEWERS) {
        const session = yield* OwnerDocs.makeDocsStream(peopleOf(who), {
          orgId,
          acceptRows: true,
        });
        const first = yield* read(who, limit);
        const rows = kinDocRowsStart(first.seq, 1);
        screens.set(who, { session, rows, page: yield* reread(who, rows, limit) });
      }

      const docKeys = sql<{ key: string; rev: number }>`SELECT key, rev FROM kin_records
        WHERE org_id = ${orgId} AND register_id = 'docs' ORDER BY key`;
      const pick = (index: number) =>
        Effect.map(docKeys, (rows) => (rows.length === 0 ? undefined : rows[index % rows.length]));
      const apply = (op: Op) =>
        Effect.gen(function* () {
          if (op._tag === "create") return yield* create(op.shared);
          if (op._tag === "projectDoc") return yield* create(false, true);
          if (op._tag === "hold")
            return yield* records.update(orgId, writer, task.row.key, {
              owner: { _tag: "person", personId: KinPersonId.make(op.on ? "mate" : "owner") },
            });
          if (op._tag === "member")
            return yield* records.update(orgId, writer, project.row.key, {
              fields: { members: op.on ? ["person:mate"] : [] },
            });
          const one = yield* pick(op.pick);
          if (one === undefined) return;
          switch (op._tag) {
            case "rewrite":
              return yield* Docs.replaceBody(
                orgId,
                writer,
                {},
                { key: one.key },
                {
                  body: `# Rewritten ${one.rev}\n\nNew words.\n`,
                  summary: "Rewritten",
                  originKey: `docs-property:rewrite:${one.key}:${one.rev}`,
                },
              );
            case "retitle":
              return yield* records.update(orgId, writer, one.key, {
                title: `Retitled ${one.key} ${one.rev}`,
              });
            case "archive":
              return yield* records.update(orgId, writer, one.key, {
                state: op.on ? "dropped" : "open",
              });
            case "share":
              return yield* records.update(orgId, writer, one.key, { team: op.on });
            case "label":
              return yield* records.update(orgId, writer, one.key, { sensitive: op.on });
          }
        });

      for (const [step, op] of ops.entries()) {
        // Each change lands later than the last, so the list's order moves.
        yield* TestClock.adjust(60_000);
        yield* Effect.exit(apply(op));
        // The owner's edit to a task marks the end of the step's ticks.
        yield* records.update(orgId, writer, sentinel.row.key, { title: `Sentinel ${step}` });
        const mark = yield* records.seq(orgId);
        const ticks: Array<KinRecords.Tick> = [];
        while (!ticks.some((tick) => tick.key === sentinel.row.key && tick.seq >= mark))
          ticks.push(...(yield* pull));
        for (const who of VIEWERS) {
          const screen = screens.get(who)!;
          // Even steps arrive as one burst, as the stream's window gathers them; odd ones singly.
          const bursts = step % 2 === 0 ? [ticks] : ticks.map((tick) => [tick]);
          const events: Array<KinDocsEvent> = [];
          for (const burst of bursts) events.push(...(yield* screen.session.burst(burst)));
          for (const event of events) screen.rows = kinApplyDocsEvent(screen.rows, event);
          // A step that sends nothing must leave the page a fresh read's too.
          const patched = kinPatchDocsPage(screen.page, screen.rows);
          screen.page =
            patched === null
              ? yield* reread(who, screen.rows, screen.page.docs.length)
              : { ...screen.page, ...patched, seq: screen.rows.seq };
          const fresh = yield* read(who, screen.page.docs.length);
          assert.deepStrictEqual(
            screen.page.docs,
            fresh.docs.slice(0, screen.page.docs.length),
            `${who}'s docs after ${op._tag} (step ${step})`,
          );
          assert.strictEqual(screen.page.total, fresh.total, `${who}'s total after ${op._tag}`);
          assert.strictEqual(screen.page.more, screen.page.docs.length < fresh.total);
        }
      }
    }),
  );

describe("Docs' live stream", () => {
  it.effect(
    "a co-owner made a member mid-stream is sent no row of a doc she may no longer see",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const records = yield* KinRecords.KinRecords;
        yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Invented Co', ${at})`;
        yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access,
          sees_docs)
        VALUES (${ownerId}, ${orgId}, 'owner', 'Owner', ${at}, 'owner', 1),
          ('cora', ${orgId}, 'cora', 'Cora', ${at}, 'co_owner', 1)`;
        yield* sql`INSERT INTO kin_session_bindings (session_id, org_id, person_id, bound_at)
        VALUES ('session-cora', ${orgId}, 'cora', 0)`;
        const writer = { actor: { _tag: "person", personId: ownerId }, via: "owner" } as const;
        const doc = yield* Docs.create(
          orgId,
          writer,
          {},
          {
            title: "Invented private plan",
            body: "# Invented private plan\n\nFirst words.\n",
            owner: { _tag: "person", personId: ownerId },
            summary: "Created",
            originKey: "docs-property:demoted",
          },
        );
        const pull = yield* Stream.toPull(records.changes(orgId));
        yield* pull;
        const cora = [{ _tag: "person" as const, orgId, personId: KinPersonId.make("cora") }];
        const session = yield* OwnerDocs.makeDocsStream(cora, { orgId, acceptRows: true });
        yield* records.update(orgId, writer, doc.row.key, { title: "Invented private plan, v2" });
        const before = yield* session.burst(yield* pull);
        assert.isDefined(
          before.find((event) => event.row !== undefined),
          "her row as a co-owner",
        );
        yield* sql`UPDATE kin_people SET access = 'member' WHERE person_id = 'cora'`;
        yield* records.update(orgId, writer, doc.row.key, { title: "Invented private plan, v3" });
        const after = yield* Effect.exit(session.burst(yield* pull));
        // The stream ends; her client subscribes again and reads what a member sees.
        assert.isTrue(after._tag === "Failure", "a row after she stopped being a co-owner");
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect.prop(
    "the Docs list patched from each viewer's stream equals a fresh read after every change",
    [history, firstPage],
    (args) => docsCase(args).pipe(Effect.provide(testLayer)),
    { arbitrary: { runs: 40 } },
  );
});
