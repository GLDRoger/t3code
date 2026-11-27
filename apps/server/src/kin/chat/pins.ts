import {
  KIN_CHAT_PINS_MAX,
  KinChatError,
  KinChatPinId,
  type KinChatPin,
  type KinChatPinInput,
  type KinChatPinsInput,
  type KinChatPinsResult,
  type KinChatUnpinInput,
  type KinGoal,
  type KinOrgId,
  type KinPersonId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as SqlClient from "effect/sql/SqlClient";

import { ownerLevel } from "../people/KinAccess.ts";
import { projectCounts } from "../work/crm.ts";
import { goalsNow, isMoneyMeasure } from "../work/goals.ts";
import { projectOpens } from "../work/ownerClients.ts";
import { milestonesOf } from "../work/projectSpine.ts";
import { byId, byKey, iso, toRecord, type RecordRow } from "../work/recordRows.ts";
import { KIN_OWNER_LEVEL, viewVisible, viewerOfPeople, type KinViewer } from "../work/teamView.ts";
import { KinChatRepository } from "./KinChatRepository.ts";
import type { PersonIdentity } from "./KinIdentity.ts";
import { KinRefreshObserver } from "./KinRefreshHub.ts";
import { roomReadable, teammatesIn } from "./memberAccess.ts";

const notFound = new KinChatError({ reason: "not_found", message: "Kin couldn't find that." });
const notAllowed = new KinChatError({
  reason: "not_allowed",
  message: "Chat operation not allowed.",
});
const notSeen = new KinChatError({
  reason: "not_allowed",
  message: "Not everyone in this chat can see this, so it can't be pinned here.",
});
const full = new KinChatError({
  reason: "invalid_state",
  message: "This chat has three pins. Unpin one first.",
});
const unavailable = new KinChatError({ reason: "unavailable", message: "Kin is unavailable." });
const isKinChatError = Schema.is(KinChatError);

type People = ReadonlyArray<PersonIdentity>;
export class KinChatPins extends Context.Service<
  KinChatPins,
  {
    readonly list: (
      people: People,
      input: KinChatPinsInput,
    ) => Effect.Effect<KinChatPinsResult, KinChatError>;
    readonly pin: (
      people: People,
      input: KinChatPinInput,
    ) => Effect.Effect<KinChatPinsResult, KinChatError>;
    readonly unpin: (
      people: People,
      input: KinChatUnpinInput,
    ) => Effect.Effect<KinChatPinsResult, KinChatError>;
  }
>()("t3/kin/chat/pins/KinChatPins") {}

export const pinSeen = Effect.fn("KinPins.seen")(function* (
  orgId: KinOrgId,
  people: ReadonlyArray<KinPersonId>,
  row: RecordRow,
  goal: KinGoal | undefined,
) {
  if (row.registerId === "goals") return goal !== undefined && !isMoneyMeasure(goal.measure);
  if (row.registerId !== "work" && row.registerId !== "milestones" && row.registerId !== "projects")
    return false;
  if (people.length > 0 && !(yield* viewVisible(orgId, people, row.recordId))) return false;
  if (row.registerId === "projects") {
    for (const personId of people) {
      const opens = yield* projectOpens(
        { person: { _tag: "person", orgId, personId }, teammate: true },
        viewerOfPeople([personId]),
        row,
        { recordId: row.recordId },
      ).pipe(
        Effect.as(true),
        Effect.catchTags({
          KinChatError: (cause) =>
            cause.reason === "not_allowed" || cause.reason === "not_found"
              ? Effect.succeed(false)
              : Effect.fail(cause),
        }),
      );
      if (!opens) return false;
    }
  }
  return true;
});

const sourceValue = Effect.fn("KinPins.sourceValue")(function* (
  row: RecordRow,
  viewer: KinViewer,
  now: number,
  goal: KinGoal | undefined,
  meta: { readonly pinId: KinChatPinId; readonly pinnedAt: string; readonly pinnedBy: string },
) {
  if (goal !== undefined && !isMoneyMeasure(goal.measure)) {
    const { key, title, state, measure, unit, current, target, dueOn, behind } = goal;
    return {
      ...meta,
      _tag: "goal",
      key,
      title,
      state,
      measure,
      current,
      target,
      dueOn,
      behind,
      ...(unit === undefined ? {} : { unit }),
    } satisfies KinChatPin;
  }
  if (row.registerId === "projects") {
    const { done, doing, open, waiting, late } = yield* projectCounts(row, now, viewer);
    return {
      ...meta,
      _tag: "project",
      key: row.key,
      name: row.title,
      state: row.state,
      targetAt: row.dueAt === null ? null : iso(row.dueAt),
      targetAllDay: row.dueAllDay === 1,
      done,
      total: done + doing + open + waiting,
      late,
    } satisfies KinChatPin;
  }
  const { key, title, state, dueAt, dueAllDay, late, steps } = toRecord(row, now);
  if (row.registerId === "milestones") {
    const [milestone] = yield* milestonesOf(
      row.orgId as KinOrgId,
      { recordId: row.recordId },
      now,
      viewer,
    );
    if (milestone !== undefined)
      return {
        ...meta,
        _tag: "task",
        key,
        title,
        state,
        dueAt,
        dueAllDay,
        late: milestone.late,
        ...(milestone.total === 0
          ? {}
          : { steps: { done: milestone.done, total: milestone.total } }),
      } satisfies KinChatPin;
  }
  return {
    ...meta,
    _tag: "task",
    key,
    title,
    state,
    dueAt,
    dueAllDay,
    late,
    ...(steps === undefined ? {} : { steps: { done: steps.done, total: steps.of } }),
  } satisfies KinChatPin;
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* KinChatRepository;
  const refresh = yield* KinRefreshObserver;

  const memberOf = Effect.fn("KinPins.memberOf")(function* (
    people: People,
    input: KinChatPinsInput,
    write: boolean,
  ) {
    const person = people.find(
      (candidate) => candidate._tag === "person" && candidate.orgId === input.orgId,
    );
    if (person === undefined) return yield* notFound;
    const chat = Option.getOrUndefined(yield* repo.getChat(input));
    if (chat === undefined || chat.archivedAt !== null || !(yield* roomReadable(person, chat)))
      return yield* notFound;
    const member = Option.getOrUndefined(
      yield* repo.activeMember({
        ...input,
        principal: { _tag: "person", personId: person.personId },
      }),
    );
    if (member === undefined) return yield* notFound;
    if (write && member.role === "guest") return yield* notAllowed;
    return person;
  });

  const stored = Effect.fn("KinPins.stored")(function* (input: KinChatPinsInput) {
    return yield* sql<{
      pinId: string;
      recordId: string;
      pinnedAt: number;
      pinnedBy: string;
      pinnedByPersonId: string;
    }>`
      SELECT p.pin_id AS "pinId", p.record_id AS "recordId", p.pinned_at AS "pinnedAt",
        p.pinned_by_person_id AS "pinnedByPersonId",
        COALESCE(person.display_name, '') AS "pinnedBy"
      FROM kin_chat_pins p LEFT JOIN kin_people person
        ON person.org_id = p.org_id AND person.person_id = p.pinned_by_person_id
      WHERE p.org_id = ${input.orgId} AND p.chat_id = ${input.chatId}
      ORDER BY p.pinned_at DESC, p.rowid DESC LIMIT ${KIN_CHAT_PINS_MAX}`;
  });

  const shownTo = Effect.fn("KinPins.shownTo")(function* (
    person: PersonIdentity,
    pins: Effect.Success<ReturnType<typeof stored>>,
    now: number,
    known?: { readonly row: RecordRow; readonly goal: KinGoal | undefined },
  ) {
    const { orgId, personId } = person;
    const isOwnerLevel = yield* ownerLevel(orgId, personId);
    const people = isOwnerLevel ? [] : [personId];
    const viewer = isOwnerLevel ? KIN_OWNER_LEVEL : viewerOfPeople(people);
    const rows = yield* Effect.forEach(pins, (pin) =>
      known?.row.recordId === pin.recordId ? Effect.succeed(known.row) : byId(orgId, pin.recordId),
    );
    const goalIds = rows.flatMap((row) =>
      row?.registerId === "goals" && row.recordId !== known?.row.recordId ? [row.recordId] : [],
    );
    const { goals } = yield* goalsNow(orgId, now, { money: false, recordIds: goalIds });
    const byRecord = new Map<string, KinGoal>(goals.map((goal) => [goal.recordId, goal]));
    return {
      pins: yield* Effect.forEach(pins, (pin, index) =>
        Effect.gen(function* () {
          const pinId = KinChatPinId.make(pin.pinId);
          const meta = { pinId, pinnedAt: iso(pin.pinnedAt), pinnedBy: pin.pinnedBy };
          const row = rows[index];
          if (row === undefined) {
            // A deleted source cannot prove that another reader used to be able to see it.
            return isOwnerLevel || pin.pinnedByPersonId === personId
              ? ({ _tag: "gone", ...meta } as const)
              : ({ _tag: "gone", pinId } as const);
          }
          const goal =
            known?.row.recordId === row.recordId ? known.goal : byRecord.get(row.recordId);
          if (!(yield* pinSeen(orgId, people, row, goal)))
            return { _tag: "hidden", pinId } as const;
          return yield* sourceValue(row, viewer, now, goal, meta);
        }),
      ),
    } satisfies KinChatPinsResult;
  });

  const transaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    sql.withTransaction(effect).pipe(
      Effect.mapError((error) => (isKinChatError(error) ? error : unavailable)),
      Effect.provideService(SqlClient.SqlClient, sql),
    );

  return KinChatPins.of({
    list: Effect.fn("KinPins.list")(function* (people, input) {
      const person = yield* memberOf(people, input, false);
      return yield* shownTo(person, yield* stored(input), yield* Clock.currentTimeMillis);
    }, transaction),
    pin: Effect.fn("KinPins.pin")(function* (people, input) {
      const person = yield* memberOf(people, input, true);
      const { orgId, chatId, key } = input;
      const row = yield* byKey(orgId, key);
      if (row === undefined) return yield* notSeen;
      const pins = yield* stored(input);
      const now = yield* Clock.currentTimeMillis;
      const {
        goals: [goal],
      } = yield* goalsNow(orgId, now, {
        money: false,
        recordIds: row.registerId === "goals" ? [row.recordId] : [],
      });
      const readers = yield* teammatesIn(orgId, chatId);
      if (!(yield* pinSeen(orgId, readers, row, goal))) return yield* notSeen;
      if (pins.some((pin) => pin.recordId === row.recordId))
        return yield* shownTo(person, pins, now);
      if (pins.length >= KIN_CHAT_PINS_MAX) return yield* full;
      const pinId = SecureRandom.uuidV4Unsafe();
      yield* sql`INSERT INTO kin_chat_pins (org_id, chat_id, record_id, pinned_by_person_id, pinned_at, pin_id)
        VALUES (${orgId}, ${chatId}, ${row.recordId}, ${person.personId}, ${now}, ${pinId})`;
      yield* refresh.touch(orgId, "pins");
      return yield* shownTo(person, yield* stored(input), now, { row, goal });
    }, transaction),
    unpin: Effect.fn("KinPins.unpin")(function* (people, input) {
      const person = yield* memberOf(people, input, true);
      const { orgId, chatId, pinId } = input;
      const pins = yield* sql`DELETE FROM kin_chat_pins
        WHERE org_id = ${orgId} AND chat_id = ${chatId} AND pin_id = ${pinId} RETURNING pin_id`;
      if (pins.length > 0) yield* refresh.touch(orgId, "pins");
      return yield* shownTo(person, yield* stored(input), yield* Clock.currentTimeMillis);
    }, transaction),
  });
});

export const layer = Layer.effect(KinChatPins, make);
