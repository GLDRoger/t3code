// @effect-diagnostics nodeBuiltinImport:off -- the guard reads TypeScript files outside an Effect.
import { assert, it } from "@effect/vitest";
import { KinAgentId, KinPersonId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Sqlite from "../../persistence/Sqlite.ts";
import * as KinRecords from "../work/KinRecords.ts";
import { undoBatch } from "../work/importUndo.ts";
import * as Chat from "./layer.ts";
import { KinIdentity } from "./KinIdentity.ts";
import { KinChatRepository } from "./KinChatRepository.ts";
import { KinChatService } from "./KinChatService.ts";
import { KinGroups } from "./KinGroups.ts";
import { KinChatPins } from "./pins.ts";
import { environment } from "./TaskCard.testkit.ts";

const layer = Chat.layerWithWork.pipe(
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(environment),
);
const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const { owner: rhea } = yield* KinIdentity;
  const { orgId } = rhea;
  const repo = yield* KinChatRepository;
  const groups = yield* KinGroups;
  const chats = yield* KinChatService;
  const records = yield* KinRecords.KinRecords;
  const pins = yield* KinChatPins;
  const createdAt = "2026-11-01T00:00:00.000Z";
  const member = Effect.fn("KinPins.testMember")(function* (
    displayName: string,
    access: "co_owner" | "member",
  ) {
    const handle = displayName.toLowerCase();
    const personId = KinPersonId.make(`kin-person-${handle}`);
    yield* repo.insertPerson({
      orgId,
      personId,
      handle,
      displayName,
      githubLogin: null,
      createdAt,
    });
    yield* sql`UPDATE kin_people SET access = ${access} WHERE person_id = ${personId}`;
    return { ...rhea, personId };
  });
  const meera = yield* member("Meera", "co_owner");
  const zoya = yield* member("Zoya", "member");
  const agentId = KinAgentId.make("kin-agent-logistics");
  yield* repo.insertAgent({
    orgId,
    agentId,
    ownerPersonId: rhea.personId,
    displayName: "Logistics lead",
    role: "lead",
    createdAt,
  });
  const direct = yield* chats.createDirect(rhea, { orgId, agentId });
  yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json,
      worker_projects_json, owner_chat_id)
      VALUES (${agentId}, ${orgId}, 'Logistics lead', 0, '{}', '[]', ${direct.chatId})`;
  const group = yield* groups.create([rhea], {
    orgId,
    title: "Tidewater Freight",
    agentIds: [agentId],
    personIds: [meera.personId],
  });
  const input = { orgId, chatId: group.chatId };
  const create = Effect.fn("KinPins.testRecord")(function* (
    item: Parameters<typeof records.create>[2],
  ) {
    return (yield* records.create(orgId, { actor: { _tag: "system" }, via: "import" }, item)).row;
  });
  const project = yield* create({
    list: "projects",
    title: "Juniper Cold Chain handover 73451",
    owner: { _tag: "person", personId: rhea.personId },
    originKey: "import:pin-redaction:project:juniper-handover",
  });
  const addZoya = groups.addMember([rhea], {
    ...input,
    principal: { _tag: "person", personId: zoya.personId },
  });
  const task = (originKey: string) =>
    create({
      list: "work",
      title: "Check the cold room",
      owner: { _tag: "person", personId: rhea.personId },
      originKey,
    });
  return { sql, rhea, meera, zoya, chats, pins, input, project, addZoya, task, create };
});

it.effect("refuses a project a group member cannot open", () =>
  Effect.gen(function* () {
    const { rhea, pins, input, project, addZoya } = yield* setup;
    yield* addZoya;
    const refusal = yield* Effect.flip(pins.pin([rhea], { ...input, key: project.key }));
    assert.strictEqual(
      refusal.message,
      "Not everyone in this chat can see this, so it can't be pinned here.",
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("withholds private source bytes after a demotion, a join, and hard deletion", () =>
  Effect.gen(function* () {
    const { sql, rhea, meera, zoya, pins, input, project, addZoya, create } = yield* setup;
    const {
      pins: [pinned],
    } = yield* pins.pin([meera], { ...input, key: project.key });
    if (pinned?._tag !== "project") return assert.fail("Expected a project pin");
    assert.strictEqual((yield* pins.list([meera], input)).pins[0]?._tag, "project");
    const open = yield* create({
      list: "work",
      title: "Check the cold room",
      owner: { _tag: "person", personId: zoya.personId },
      originKey: "import:pin-redaction:task:cold-room",
    });
    const {
      pins: [visible],
    } = yield* pins.pin([meera], { ...input, key: open.key });
    if (visible?._tag !== "task") return assert.fail("Expected a task pin");
    yield* sql`UPDATE kin_people SET access = 'member' WHERE person_id = ${meera.personId}`;
    const hidden = { _tag: "hidden", pinId: pinned.pinId } as const;
    const demoted = yield* pins.list([meera], input);
    assert.deepStrictEqual(demoted.pins, [{ _tag: "hidden", pinId: visible.pinId }, hidden]);
    const bytes = JSON.stringify(demoted);
    for (const secret of [project.title, "Juniper Cold Chain", "73451", project.key])
      assert.notInclude(bytes, secret);
    assert.deepInclude((yield* pins.list([rhea], input)).pins, pinned);
    yield* addZoya;
    assert.deepStrictEqual((yield* pins.list([zoya], input)).pins, [visible, hidden]);
    const attempt = yield* Effect.flip(pins.pin([zoya], { ...input, key: project.key }));
    assert.strictEqual(attempt.reason, "not_allowed");

    yield* undoBatch(input.orgId, rhea.personId, "pin-redaction", {
      apply: true,
      includeChanged: false,
    });

    const goneTask = { _tag: "gone", pinId: visible.pinId } as const;
    const goneProject = { _tag: "gone", pinId: pinned.pinId } as const;
    const goneBytes = JSON.stringify(yield* pins.list([zoya], input));
    assert.notInclude(goneBytes, "pinnedBy");
    assert.notInclude(goneBytes, "pinnedAt");
    assert.deepStrictEqual(JSON.parse(goneBytes), { pins: [goneTask, goneProject] });
    for (const reader of [rhea, meera]) {
      assert.deepStrictEqual((yield* pins.list([reader], input)).pins, [
        { ...goneTask, pinnedBy: visible.pinnedBy, pinnedAt: visible.pinnedAt },
        { ...goneProject, pinnedBy: pinned.pinnedBy, pinnedAt: pinned.pinnedAt },
      ]);
    }
    assert.deepStrictEqual((yield* pins.unpin([zoya], { ...input, pinId: pinned.pinId })).pins, [
      goneTask,
    ]);
  }).pipe(Effect.provide(layer)),
);

it.effect("counts only a viewer's own project tasks and recalculates after a Work change", () =>
  Effect.gen(function* () {
    const { sql, rhea, zoya, pins, input, project, addZoya, create } = yield* setup;
    yield* sql`UPDATE kin_records SET fields_json = ${JSON.stringify({
      members: [`person:${zoya.personId}`],
    })} WHERE record_id = ${project.recordId}`;
    const owner = { _tag: "person" as const, personId: rhea.personId };
    const open = yield* create({
      list: "work",
      title: "Open the cold room",
      owner,
      originKey: "kin-task-open-cold-room",
      projectId: project.recordId,
    });
    yield* create({
      list: "work",
      title: "Count the backup inventory",
      owner,
      originKey: "kin-task-inventory",
      projectId: project.recordId,
      sensitive: true,
      state: "done",
    });
    yield* addZoya;
    const {
      pins: [pinned],
    } = yield* pins.pin([rhea], { ...input, key: project.key });
    assert.include(pinned, { _tag: "project", done: 1, total: 2 });
    assert.include((yield* pins.list([zoya], input)).pins[0], {
      _tag: "project",
      done: 0,
      total: 1,
    });
    yield* sql`UPDATE kin_records SET state = 'done' WHERE record_id = ${open.recordId}`;
    assert.include((yield* pins.list([zoya], input)).pins[0], {
      _tag: "project",
      done: 1,
      total: 1,
    });
  }).pipe(Effect.provide(layer)),
);

it.effect("keeps a dropped task shown and an undone import gone", () =>
  Effect.gen(function* () {
    const { sql, rhea, pins, input, task } = yield* setup;
    const dropped = yield* task("kin-task-drop");
    const imported = yield* task("import:juniper:kin-task-check");
    yield* pins.pin([rhea], { ...input, key: dropped.key });
    const {
      pins: [added],
    } = yield* pins.pin([rhea], { ...input, key: imported.key });
    if (added?._tag !== "task") return assert.fail("Expected a task pin");
    yield* sql`UPDATE kin_records SET state = 'dropped' WHERE record_id = ${dropped.recordId}`;
    yield* undoBatch(input.orgId, rhea.personId, "juniper", { apply: true, includeChanged: false });
    const read = (yield* pins.list([rhea], input)).pins;
    assert.deepInclude(read, {
      _tag: "gone",
      pinId: added.pinId,
      pinnedAt: added.pinnedAt,
      pinnedBy: added.pinnedBy,
    });
    const one = read.find((pin) => pin._tag === "task");
    assert.strictEqual(one?.state, "dropped");
  }).pipe(Effect.provide(layer)),
);

it.effect("deduplicates, caps, removes and clears pins, while refusing a guest's writes", () =>
  Effect.gen(function* () {
    const { sql, rhea, meera, chats, pins, input, task } = yield* setup;
    const [a, b, c, d] = yield* Effect.forEach(["a", "b", "c", "d"], (id) =>
      task(`kin-task-${id}`),
    );
    const {
      pins: [first],
    } = yield* pins.pin([rhea], { ...input, key: a!.key });
    assert.isDefined(first);
    yield* pins.pin([rhea], { ...input, key: b!.key });
    yield* pins.pin([rhea], { ...input, key: c!.key });
    const repeat = yield* pins.pin([rhea], { ...input, key: a!.key });
    assert.deepInclude(repeat.pins, first);
    assert.lengthOf(repeat.pins, 3);
    const fourth = yield* Effect.flip(pins.pin([rhea], { ...input, key: d!.key }));
    assert.strictEqual(fourth.message, "This chat has three pins. Unpin one first.");
    yield* sql`UPDATE kin_chat_members SET role = 'guest'
      WHERE chat_id = ${input.chatId} AND person_id = ${meera.personId}`;
    assert.strictEqual(
      (yield* Effect.flip(pins.pin([meera], { ...input, key: a!.key }))).reason,
      "not_allowed",
    );
    assert.strictEqual(
      (yield* Effect.flip(pins.unpin([meera], { ...input, pinId: first.pinId }))).reason,
      "not_allowed",
    );
    yield* sql`UPDATE kin_chat_members SET role = 'member'
      WHERE chat_id = ${input.chatId} AND person_id = ${meera.personId}`;
    assert.lengthOf((yield* pins.unpin([meera], { ...input, pinId: first.pinId })).pins, 2);
    yield* chats.clear([rhea], { ...input, preview: true });
    assert.lengthOf((yield* pins.list([rhea], input)).pins, 2);
    yield* chats.clear([rhea], input);
    assert.deepStrictEqual((yield* pins.list([rhea], input)).pins, []);
  }).pipe(Effect.provide(layer)),
);

it.effect("refuses Money goals and Money-shaped targets", () =>
  Effect.gen(function* () {
    const { rhea, pins, input, create } = yield* setup;
    for (const measure of ["revenue_received", "manual"]) {
      const goal = yield* create({
        list: "goals",
        title:
          measure === "manual"
            ? "Juniper Cold Chain manually tracked revenue"
            : "Juniper Cold Chain revenue",
        owner: { _tag: "person", personId: rhea.personId },
        originKey: `kin-goal-${measure}`,
        fields: { measure, target: { minor: 73451, currency: "INR" } },
      });
      assert.strictEqual(
        (yield* Effect.flip(pins.pin([rhea], { ...input, key: goal.key }))).reason,
        "not_allowed",
      );
    }
  }).pipe(Effect.provide(layer)),
);

it("keeps live pin mutations out of MCP, lead and scheduled pulse code", () => {
  const kin = NodePath.resolve(import.meta.dirname, "..");
  const access =
    /\bKinChatPins\b|\bchat(?:Pin|Unpin)\b|\bkin\.chat\.(?:pin|unpin)\b|["'\x60][^"'\x60]*chat\/pins\.ts["'\x60]/;
  const reached = ["mcp", "lead", "pulse"].flatMap((folder) => {
    const root = NodePath.join(kin, folder);
    return NodeFS.readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((path) => path.endsWith(".ts") && !path.endsWith(".test.ts"))
      .filter((path) => access.test(NodeFS.readFileSync(NodePath.join(root, path), "utf8")))
      .map((path) => NodePath.join(folder, path));
  });
  assert.deepStrictEqual(reached, []);
});

it.effect("admits and reads a source only through its own screen's gates, as they change", () =>
  Effect.gen(function* () {
    const { sql, rhea, zoya, pins, input, project, addZoya, create } = yield* setup;
    yield* addZoya;
    const shown = () =>
      pins.list([zoya], input).pipe(Effect.map(({ pins }) => pins.map((pin) => pin._tag)));
    const members = (people: ReadonlyArray<string>) =>
      sql`UPDATE kin_records SET fields_json = ${JSON.stringify({ members: people })}
        WHERE record_id = ${project.recordId}`;
    yield* members([`person:${zoya.personId}`]);
    yield* pins.pin([rhea], { ...input, key: project.key });
    assert.deepStrictEqual(yield* shown(), ["project"]);
    // A Clients place alone opens no project page, so it opens no pin of one either.
    yield* sql`UPDATE kin_people SET sees_clients = 1 WHERE person_id = ${zoya.personId}`;
    yield* members([]);
    assert.deepStrictEqual(yield* shown(), ["hidden"]);
    const zoyas = { _tag: "person" as const, personId: zoya.personId };
    const open = yield* create({
      list: "work",
      title: "Open the cold room",
      owner: zoyas,
      originKey: "kin-task-cold-room-open",
    });
    const secret = yield* create({
      list: "work",
      title: "Count the backup inventory",
      owner: { _tag: "person", personId: rhea.personId },
      originKey: "kin-task-secret",
      sensitive: true,
    });
    assert.strictEqual(
      (yield* Effect.flip(pins.pin([rhea], { ...input, key: secret.key }))).reason,
      "not_allowed",
    );
    yield* pins.pin([rhea], { ...input, key: open.key });
    assert.deepStrictEqual(yield* shown(), ["task", "hidden"]);
    yield* sql`UPDATE kin_records SET owner_id = ${rhea.personId}, sensitive = 1
      WHERE record_id = ${open.recordId}`;
    assert.deepStrictEqual(yield* shown(), ["hidden", "hidden"]);
    assert.deepStrictEqual(
      (yield* pins.list([rhea], input)).pins.map((pin) => pin._tag),
      ["task", "project"],
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("keeps a pin to its chat and out of archived groups and the Team room", () =>
  Effect.gen(function* () {
    const { sql, rhea, meera, zoya, pins, input, addZoya, create } = yield* setup;
    yield* addZoya;
    const one = yield* create({
      list: "work",
      title: "Check the cold room",
      owner: { _tag: "person", personId: zoya.personId },
      originKey: "kin-task-cold-room-one",
    });
    const {
      pins: [pinned],
    } = yield* pins.pin([rhea], { ...input, key: one.key });
    assert.isDefined(pinned);
    const other = yield* (yield* KinGroups).create([rhea], {
      orgId: input.orgId,
      title: "Juniper Cold Chain",
      agentIds: [],
      personIds: [meera.personId],
    });
    const elsewhere = { orgId: input.orgId, chatId: other.chatId };
    assert.deepStrictEqual(
      (yield* pins.unpin([rhea], { ...elsewhere, pinId: pinned.pinId })).pins,
      [],
    );
    assert.lengthOf((yield* pins.list([rhea], input)).pins, 1);
    yield* sql`UPDATE kin_chats SET team_id = 'team-room' WHERE chat_id = ${input.chatId}`;
    assert.strictEqual((yield* Effect.flip(pins.list([zoya], input))).reason, "not_found");
    assert.lengthOf((yield* pins.list([rhea], input)).pins, 1);
    yield* sql`UPDATE kin_chats SET team_id = NULL, archived_at = 1 WHERE chat_id = ${input.chatId}`;
    for (const who of [rhea, zoya])
      assert.strictEqual((yield* Effect.flip(pins.list([who], input))).reason, "not_found");
    assert.strictEqual(
      (yield* Effect.flip(pins.unpin([rhea], { ...input, pinId: pinned.pinId }))).reason,
      "not_found",
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("counts a milestone's steps by each reader's own tasks", () =>
  Effect.gen(function* () {
    const { sql, rhea, zoya, pins, input, project, addZoya, create } = yield* setup;
    const owner = { _tag: "person" as const, personId: rhea.personId };
    yield* sql`UPDATE kin_records SET fields_json = ${JSON.stringify({
      members: [`person:${zoya.personId}`],
    })} WHERE record_id = ${project.recordId}`;
    const milestone = yield* create({
      list: "milestones",
      title: "Cold room ready",
      owner,
      originKey: "kin-milestone-cold-room",
      projectId: project.recordId,
    });
    for (const [originKey, sensitive] of [
      ["kin-task-milestone-open", false],
      ["kin-task-milestone-secret", true],
    ] as const) {
      const linked = yield* create({
        list: "work",
        title: "Check the cold room",
        owner,
        originKey,
        sensitive,
        projectId: project.recordId,
      });
      yield* sql`UPDATE kin_records SET fields_json = ${JSON.stringify({ milestone: milestone.key })}
        WHERE record_id = ${linked.recordId}`;
    }
    yield* addZoya;
    const {
      pins: [pinned],
    } = yield* pins.pin([rhea], { ...input, key: milestone.key });
    assert.deepInclude(pinned, { _tag: "task", steps: { done: 0, total: 2 } });
    assert.deepInclude((yield* pins.list([zoya], input)).pins[0], {
      _tag: "task",
      steps: { done: 0, total: 1 },
    });
  }).pipe(Effect.provide(layer)),
);

it.effect("hides a pinned goal whose target becomes Money", () =>
  Effect.gen(function* () {
    const { sql, rhea, pins, input, create } = yield* setup;
    const goal = yield* create({
      list: "goals",
      title: "Juniper Cold Chain deliveries",
      owner: { _tag: "person", personId: rhea.personId },
      originKey: "kin-goal-deliveries",
      fields: { measure: "manual", target: "12", current: "3" },
    });
    const {
      pins: [pinned],
    } = yield* pins.pin([rhea], { ...input, key: goal.key });
    assert.include(pinned, { _tag: "goal", current: 3, target: 12 });
    if (pinned === undefined) return assert.fail("Expected a pin");
    yield* sql`UPDATE kin_records SET fields_json = ${JSON.stringify({
      measure: "manual",
      target: { minor: 73451, currency: "INR" },
      current: "3",
    })} WHERE record_id = ${goal.recordId}`;
    assert.deepStrictEqual((yield* pins.list([rhea], input)).pins, [
      { _tag: "hidden", pinId: pinned.pinId },
    ]);
  }).pipe(Effect.provide(layer)),
);
