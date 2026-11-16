import { assert, layer } from "@effect/vitest";
import { KinOrgId, KinPersonId } from "@t3tools/contracts";
import * as Arbitrary from "effect/Arbitrary";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../../persistence/Sqlite.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import { personSees } from "../work/teamView.ts";
import * as KinPulse from "./KinPulse.ts";

// Invented orgs, people and tasks only.
const AT = Date.UTC(2026, 10, 15, 6);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const DEFAULTS = { due_soon_hours: 24, stalled_after_days: 3, waiting_too_long_days: 5 };

const int = (minimum: number, maximum: number) =>
  Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum, maximum })));
const pick = <const L extends ReadonlyArray<string>>(literals: L) =>
  Arbitrary.schema(Schema.Literals(literals));
const flag = Arbitrary.schema(Schema.Boolean);
const maybe = <A>(arb: Arbitrary.Arbitrary<A>) =>
  Arbitrary.all([flag, arb]).pipe(Arbitrary.map(([some, value]) => (some ? value : null)));

const task = Arbitrary.all({
  state: pick(["open", "doing", "waiting", "done", "dropped"]),
  side: pick(["ours", "theirs"]),
  holder: pick(["owner", "ana", "ben", "cos"]),
  madeBy: pick(["owner", "ana"]),
  sensitive: flag,
  shared: flag,
  confirmed: flag,
  inProject: flag,
  /** Hours from now to its due time: past, soon, or well ahead. */
  due: maybe(int(-100, 400)),
  /** Hours since anything last changed on it. */
  quiet: int(0, 400),
  /** Days since it was made. */
  age: int(0, 30),
});
type Task = typeof task extends Arbitrary.Arbitrary<infer A> ? A : never;
const playbook = maybe(
  Arbitrary.all({
    due_soon_hours: maybe(int(1, 336)),
    stalled_after_days: maybe(int(1, 60)),
    waiting_too_long_days: maybe(int(1, 60)),
  }),
);
const world = Arbitrary.all({
  tasks: Arbitrary.array(task, { minLength: 1, maxLength: 8 }),
  playbook,
});
type World = typeof world extends Arbitrary.Arbitrary<infer A> ? A : never;

const testLayer = KinEventQueue.layer.pipe(
  Layer.provideMerge(KinPersistence.layer),
  Layer.provideMerge(Sqlite.layerMemory),
);

/** A fresh org per run: the owner, Ana and Ben, a Chief of staff, one project Ana is on. */
const install = (w: World) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [count] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_orgs`;
    const orgId = KinOrgId.make(`org-${count?.n ?? 0}`);
    const id = (name: string) => `${orgId}-${name}`;
    yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Invented Studio', '2026-10-01')`;
    yield* sql`INSERT INTO kin_trigger_settings (org_id, time_zone, morning_brief, evening_summary,
        dream, full_rebuild_weekday, owner_check_weekday, owner_check, quiet_hours_json)
      VALUES (${orgId}, 'UTC', '08:30', '18:00', '02:00', 0, 1, '09:00', '{}')`;
    for (const person of ["owner", "ana", "ben"])
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
        VALUES (${id(person)}, ${orgId}, ${person}, ${person}, '2026-10-01',
          ${person === "owner" ? "owner" : "member"})`;
    yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
      VALUES (${id("cos")}, ${orgId}, 'Chief', 'lead', ${id("owner")}, '2026-10-01')`;
    yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, last_seq, created_at)
      VALUES (${id("chat")}, ${orgId}, 'team_group', 0, '2026-10-01')`;
    yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json,
        worker_projects_json, owner_chat_id, domain)
      VALUES (${id("cos")}, ${orgId}, 'Chief', 0, '{}', '[]', ${id("chat")}, 'chief-of-staff')`;
    for (const [list, prefix] of [
      ["work", "W"],
      ["projects", "P"],
      ["docs", "D"],
      ["milestones", "M"],
    ] as const)
      yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in, created_at)
        VALUES (${orgId}, ${list}, ${list}, ${prefix}, 1, 0)`;
    const row = (
      recordId: string,
      list: string,
      key: string,
      values: {
        state?: string;
        side?: string;
        ownerKind?: string;
        ownerId?: string;
        madeBy?: string;
        sensitive?: boolean;
        shared?: boolean;
        confirmed?: boolean;
        dueAt?: number | null;
        createdAt?: number;
        updatedAt?: number;
        fields?: string;
        projectId?: string | null;
        category?: string | null;
      },
    ) =>
      sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, state, owner_kind,
          owner_id, side, category, due_at, confirmed, sensitive, team_shared, created_by_kind,
          created_by_id, origin_key, created_at, updated_at, fields_json, project_id)
        VALUES (${orgId}, ${recordId}, ${list}, ${key}, ${`Invented ${key}`},
          ${values.state ?? "open"}, ${values.ownerKind ?? "person"},
          ${values.ownerId ?? id("owner")}, ${values.side ?? "ours"}, ${values.category ?? null},
          ${values.dueAt ?? null}, ${values.confirmed === false ? 0 : 1},
          ${values.sensitive === true ? 1 : 0}, ${values.shared === true ? 1 : 0}, 'person',
          ${values.madeBy ?? id("owner")}, ${recordId}, ${values.createdAt ?? AT - 60 * DAY},
          ${values.updatedAt ?? AT - 60 * DAY}, ${values.fields ?? "{}"},
          ${values.projectId ?? null})`;
    yield* row(id("P-1"), "projects", "P-1", {
      fields: JSON.stringify({ members: [`person:${id("ana")}`] }),
    });
    if (w.playbook !== null) {
      const lines = Object.entries(w.playbook).flatMap(([key, value]) =>
        value === null ? [] : [`${key}: ${value}`],
      );
      yield* row(id("D-1"), "docs", "D-1", { category: "playbook" });
      yield* sql`INSERT INTO kin_doc_versions (org_id, record_id, version, body, title, kind,
          summary, operations_json, actor_kind, actor_id, via, origin_key, created_at)
        VALUES (${orgId}, ${id("D-1")}, 1, ${`# How we work\n\n\`\`\`kin\n${lines.join("\n")}\n\`\`\`\n`},
          'How we work', 'created', 'Seeded', '[]', 'person', ${id("owner")}, 'owner',
          ${id("seed-D-1")}, 0)`;
    }
    for (const [index, t] of w.tasks.entries()) {
      const recordId = id(`W-${index + 1}`);
      const createdAt = AT - t.age * DAY - HOUR;
      yield* row(recordId, "work", `W-${index + 1}`, {
        state: t.state,
        side: t.side,
        ownerKind: t.holder === "cos" ? "agent" : "person",
        ownerId: id(t.holder),
        madeBy: id(t.madeBy),
        sensitive: t.sensitive,
        shared: t.shared,
        confirmed: t.confirmed,
        dueAt: t.due === null ? null : AT + t.due * HOUR,
        createdAt,
        updatedAt: createdAt,
        projectId: t.inProject ? id("P-1") : null,
      });
      const changed = Math.min(AT - t.quiet * HOUR, AT);
      yield* sql`INSERT INTO kin_record_changes (org_id, record_id, rev, at, actor_kind, actor_id,
          via, kind, fields_json)
        VALUES (${orgId}, ${recordId}, 1, ${changed}, 'person', ${id("owner")}, 'owner', 'updated',
          ${JSON.stringify(t.state === "waiting" ? [{ field: "state", from: "open", to: "waiting" }] : [])})`;
    }
    return { orgId, id };
  });

const read = (orgId: KinOrgId, viewer: KinPulse.Viewer) =>
  KinPulse.read({ orgId, at: AT, viewer, includeHandled: true, limit: 200 });

layer(testLayer)("pulse facts", (it) => {
  it.effect.prop(
    "every fact names an entry that exists, once per cause, and a teammate reads only facts on tasks she may see",
    [world],
    ([w]) =>
      Effect.gen(function* () {
        const { orgId, id } = yield* install(w);
        const sql = yield* SqlClient.SqlClient;
        const owner = yield* read(orgId, { _tag: "owner" });
        assert.strictEqual(new Set(owner.facts.map((fact) => fact.key)).size, owner.facts.length);
        const rows = yield* sql<{ recordId: string; key: string }>`SELECT record_id AS "recordId",
            key FROM kin_records WHERE org_id = ${orgId}`;
        const keyOf = new Map(rows.map((one) => [one.recordId, one.key]));
        for (const fact of owner.facts.filter((one) => one.subject.recordId !== undefined))
          assert.strictEqual(keyOf.get(fact.subject.recordId!), fact.subject.key, fact.key);
        for (const member of ["ana", "ben"]) {
          const personId = KinPersonId.make(id(member));
          const theirs = yield* read(orgId, { _tag: "people", people: [personId] });
          const sees = new Set(
            (yield* sql<{ recordId: string }>`SELECT r.record_id AS "recordId" FROM kin_records r
              WHERE r.org_id = ${orgId} AND ${personSees(sql, personId)}`).map(
              (one) => one.recordId,
            ),
          );
          const shown = new Set(owner.facts.map((fact) => fact.key));
          for (const fact of theirs.facts) {
            assert.strictEqual(fact.family, "work", fact.key);
            assert.isFalse(fact.sensitive, fact.key);
            assert.isTrue(sees.has(fact.subject.recordId!), `${member} reads ${fact.key}`);
            assert.isTrue(shown.has(fact.key), `${fact.key} is the owner's too`);
          }
        }
      }),
  );

  it.effect.prop(
    "a fact goes when its cause does: closing a task leaves no fact on it and other tasks' facts as they were",
    [world, int(0, 7)],
    ([w, which]) =>
      Effect.gen(function* () {
        const { orgId, id } = yield* install(w);
        const sql = yield* SqlClient.SqlClient;
        const before = (yield* read(orgId, { _tag: "owner" })).facts;
        const closed = id(`W-${(which % w.tasks.length) + 1}`);
        yield* sql`UPDATE kin_records SET state = 'done', closed_at = ${AT}
          WHERE org_id = ${orgId} AND record_id = ${closed}`;
        const after = (yield* read(orgId, { _tag: "owner" })).facts;
        // A project left with no open task gets its own fact (project_no_plan): a new cause.
        const onTasks = (facts: typeof before) =>
          facts
            .filter((fact) => /^W-/.test(fact.subject.key ?? ""))
            .map((fact) => fact.key)
            .toSorted();
        assert.deepStrictEqual(
          onTasks(after),
          onTasks(before.filter((fact) => fact.subject.recordId !== closed)),
        );
      }),
  );

  it.effect.prop(
    "a threshold is the playbook's when it sets one, else the default, and decides which tasks it names",
    [world],
    ([w]) =>
      Effect.gen(function* () {
        const { orgId } = yield* install(w);
        const facts = (yield* read(orgId, { _tag: "owner" })).facts;
        const set = (key: keyof typeof DEFAULTS) => w.playbook?.[key] ?? null;
        for (const [sense, key] of [
          ["task_due_soon", "due_soon_hours"],
          ["task_stalled", "stalled_after_days"],
          ["waiting_long", "waiting_too_long_days"],
        ] as const)
          for (const fact of facts.filter((one) => one.sense === sense)) {
            assert.strictEqual(fact.measure?.threshold, set(key) ?? DEFAULTS[key], fact.key);
            assert.strictEqual(
              fact.measure?.from._tag,
              set(key) === null ? "default" : "playbook",
              fact.key,
            );
          }
        const soon = (set("due_soon_hours") ?? DEFAULTS.due_soon_hours) * HOUR;
        const stalled = (set("stalled_after_days") ?? DEFAULTS.stalled_after_days) * DAY;
        const named = (sense: string) =>
          facts
            .filter((one) => one.sense === sense)
            .map((one) => one.subject.key)
            .toSorted();
        const tasks = (keep: (t: Task) => boolean) =>
          w.tasks.flatMap((t, index) => (keep(t) ? [`W-${index + 1}`] : [])).toSorted();
        assert.deepStrictEqual(
          named("task_due_soon"),
          tasks(
            (t) =>
              t.state === "open" &&
              t.side === "ours" &&
              t.due !== null &&
              t.due > 0 &&
              t.due * HOUR <= soon,
          ),
        );
        assert.deepStrictEqual(
          named("task_stalled"),
          tasks((t) => t.state === "doing" && t.quiet * HOUR >= stalled),
        );
      }),
  );
});
