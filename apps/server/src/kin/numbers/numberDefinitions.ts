import {
  KinChatError,
  KinRecordKey,
  type KinNumberDefinition,
  type KinNumberSaveInput,
  type KinOrgId,
} from "@t3tools/contracts";
import * as BigDecimal from "effect/BigDecimal";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import type { PersonIdentity } from "../chat/KinIdentity.ts";
import { goalFields } from "../work/goals.ts";
import { KinRecords, requestHashOf } from "../work/KinRecords.ts";
import { parseFields } from "../work/lists.ts";
import { inList, ownerWriter, theOwner } from "../work/ownerWork.ts";
import { keptEntry } from "../work/recordRows.ts";
import { numberFields, targetless } from "./numberRows.ts";

const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });
const unavailable = (cause: unknown) =>
  Effect.logWarning("Kin number definitions query failed", { cause }).pipe(
    Effect.andThen(
      Effect.fail(new KinChatError({ reason: "unavailable", message: "Kin is unavailable." })),
    ),
  );

type Row = {
  readonly key: string;
  readonly rev: number;
  readonly title: string;
  readonly state: string;
  readonly fields: string;
  readonly teamShared: number;
};

const definitionOf = (row: Row): KinNumberDefinition | undefined => {
  const fields = numberFields(parseFields(row.fields));
  if (fields === undefined) return undefined;
  return {
    key: KinRecordKey.make(row.key),
    rev: row.rev,
    name: row.title,
    ...(fields.unit === undefined ? {} : { unit: fields.unit }),
    ...(fields.direction === undefined ? {} : { direction: fields.direction }),
    ...(fields.every === undefined ? {} : { every: fields.every }),
    ...(fields.above === undefined ? {} : { above: fields.above }),
    ...(fields.below === undefined ? {} : { below: fields.below }),
    ...(fields.source === undefined ? {} : { source: fields.source }),
    computed: fields.kind === "computed",
    shared: row.teamShared === 1,
    archived: row.state === "dropped",
  };
};

const rowsOf = Effect.fn("KinNumbers.definitionRows")(function* (orgId: KinOrgId, key?: string) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<Row>`SELECT r.key, r.rev, r.title, r.state, r.fields_json AS fields,
      r.team_shared AS "teamShared"
    FROM kin_records r WHERE r.org_id = ${orgId} AND r.register_id = 'goals'
      AND ${keptEntry(sql)} AND ${targetless(sql)}
      AND json_extract(r.fields_json, '$.measure') = 'manual'
      AND ${key === undefined ? sql`1` : sql`r.key = ${key}`}
    ORDER BY r.state = 'dropped', LENGTH(r.key), r.key`;
});

/** Every watched number with how it is set up, archived ones last: the owner level's alone. */
export const definitions = Effect.fn("KinNumbers.definitionsFor")(
  function* (people: ReadonlyArray<PersonIdentity>, orgId: KinOrgId) {
    yield* theOwner(people, orgId);
    const rows = yield* rowsOf(orgId);
    return { numbers: rows.flatMap((row) => definitionOf(row) ?? []) };
  },
  Effect.catchTags({ SqlError: unavailable }),
);

/**
 * The owner level watches a number (a goals entry with no target), or changes, archives or
 * restores one. A computed number's spec stays as an agent set it.
 */
export const save = Effect.fn("KinNumbers.save")(
  function* (people: ReadonlyArray<PersonIdentity>, input: KinNumberSaveInput) {
    const person = yield* theOwner(people, input.orgId);
    const records = yield* KinRecords;
    if (
      input.above != null &&
      input.below != null &&
      BigDecimal.Order(
        BigDecimal.fromStringUnsafe(input.below),
        BigDecimal.fromStringUnsafe(input.above),
      ) > 0
    )
      return yield* invalid("The lower limit is above the upper one.");
    const fields = yield* goalFields(input.orgId, {
      ...(input.key === undefined ? { measure: "manual" } : {}),
      ...(input.unit === undefined ? {} : { unit: input.unit }),
      ...(input.direction === undefined ? {} : { direction: input.direction }),
      ...(input.every === undefined ? {} : { every: input.every }),
      ...(input.above === undefined ? {} : { above: input.above }),
      ...(input.below === undefined ? {} : { below: input.below }),
      ...(input.source === undefined ? {} : { source: input.source }),
    });
    const writer = ownerWriter(person);
    const state =
      input.archived === undefined ? {} : ({ state: input.archived ? "dropped" : "open" } as const);
    const team = input.shared === undefined ? {} : { team: input.shared };
    const key =
      input.key === undefined
        ? (yield* records.create(input.orgId, writer, {
            list: "goals",
            originKey: `owner:number:${input.clientRequestId}`,
            requestHash: requestHashOf(input),
            title: input.name,
            owner: { _tag: "person", personId: person.personId },
            fields,
            ...team,
            ...state,
          })).row.key
        : yield* Effect.gen(function* () {
            yield* inList(input.orgId, input.key!, "goals");
            const [held] = yield* rowsOf(input.orgId, input.key);
            if (held === undefined)
              return yield* invalid("That is a goal with a target. Change it on the goal.");
            const row = yield* records.update(
              input.orgId,
              writer,
              input.key!,
              { title: input.name, fields, ...team, ...state },
              input.rev,
            );
            return row.key;
          });
    const [row] = yield* rowsOf(input.orgId, key);
    const saved = row === undefined ? undefined : definitionOf(row);
    if (saved === undefined)
      return yield* new KinChatError({ reason: "not_found", message: "Kin couldn't find that." });
    return saved;
  },
  Effect.catchTags({ SqlError: unavailable }),
);
