import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as HouseLineService from "../../../kin/houseLine/HouseLineService.ts";
import { requireThreadScope } from "../../McpInvocationContext.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { loadCaller, resolveProjectId } from "../../threadAccess.ts";
import { LineageToolkit } from "./tools.ts";

const asRequest = (cause: HouseLineService.HouseLineError) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: cause.message });

const threadId = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  return (yield* requireThreadScope(scope, "The lineage tools")).thread.threadId;
});

export const layer = McpToolAccess.toLayer(LineageToolkit, {
  lineage_add: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const houseLine = yield* HouseLineService.HouseLineService;
      return yield* houseLine
        .addNote({
          threadId: yield* threadId,
          body: input.body,
          ...(input.houses === undefined ? {} : { houseNames: input.houses }),
        })
        .pipe(Effect.mapError(asRequest));
    }),
  ),
  lineage_read: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      if (input.subject === "wills" || input.subject === "all") {
        yield* McpToolAccess.assertHouseLineSeesWills();
      }
      const houseLine = yield* HouseLineService.HouseLineService;
      return yield* houseLine
        .read({
          threadId: yield* threadId,
          ...(input.subject === undefined ? {} : { subject: input.subject }),
          ...(input.house === undefined ? {} : { houseName: input.house }),
          ...(input.since === undefined ? {} : { since: input.since }),
          ...(input.authorLaneId === undefined ? {} : { authorLaneId: input.authorLaneId }),
        })
        .pipe(Effect.mapError(asRequest));
    }),
  ),
  lineage_areas: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const caller = yield* loadCaller();
      const projectId = yield* resolveProjectId(caller, undefined);
      const houseLine = yield* HouseLineService.HouseLineService;
      const houses = yield* houseLine.areas(projectId).pipe(Effect.mapError(asRequest));
      return { houses };
    }),
  ),
  lineage_crown: McpToolAccess.actsAsCaller(() =>
    Effect.gen(function* () {
      yield* McpToolAccess.assertHouseLineCrownable();
      const houseLine = yield* HouseLineService.HouseLineService;
      return yield* houseLine.crown(yield* threadId).pipe(Effect.mapError(asRequest));
    }),
  ),
  lineage_will: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      yield* McpToolAccess.assertHouseLineCrownable();
      const houseLine = yield* HouseLineService.HouseLineService;
      return yield* houseLine
        .will({ threadId: yield* threadId, body: input.body })
        .pipe(Effect.mapError(asRequest));
    }),
  ),
  lineage_lineages: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const houseLine = yield* HouseLineService.HouseLineService;
      return yield* houseLine.lineages(yield* threadId).pipe(Effect.mapError(asRequest));
    }),
  ),
});
