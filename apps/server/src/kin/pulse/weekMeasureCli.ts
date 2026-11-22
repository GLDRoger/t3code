import { KinOrgId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import { lastCompleteWeek, weekMeasure } from "./weekMeasure.ts";

export const readWeekMeasure = (filename: string, org: string, now: number) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const orgId = KinOrgId.make(org);
      const window = yield* lastCompleteWeek(orgId, now);
      return yield* weekMeasure({ orgId, ...window });
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename, readonly: true }))),
  );
