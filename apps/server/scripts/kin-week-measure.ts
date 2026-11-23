import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { KinOrgId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { lastCompleteWeek, weekMeasure } from "../src/kin/pulse/weekMeasure.ts";

const decodeArgs = Schema.decodeUnknownEffect(
  Schema.Tuple([Schema.NonEmptyString, KinOrgId, Schema.NumberFromString]),
);
const encodeCounts = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

Effect.gen(function* () {
  const [filename, orgId, now] = yield* decodeArgs(process.argv.slice(2));
  const counts = yield* Effect.gen(function* () {
    const window = yield* lastCompleteWeek(orgId, now);
    return yield* weekMeasure({ orgId, ...window });
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename, readonly: true })));
  yield* Console.log(yield* encodeCounts(counts));
}).pipe(NodeRuntime.runMain);
