import { assert, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthSessionId,
  AuthStandardClientScopes,
  KinActionId,
  KinOrgId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { requiredScopeForRpcMethod } from "../../auth/RpcAuthorization.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import { makeKinApprovalHandlers } from "./rpcHandlers.ts";

it.effect("key and grant methods refuse as disabled when Kin is off", () =>
  Effect.gen(function* () {
    const handlers = yield* makeKinApprovalHandlers(
      {
        sessionId: AuthSessionId.make("session"),
        subject: "browser",
        method: "browser-session-cookie",
        scopes: AuthStandardClientScopes,
      },
      Option.none(),
    );
    const orgId = KinOrgId.make("org_01");
    assert.include(yield* handlers["kin.approvals.listKeys"]({ orgId }).pipe(Effect.flip), {
      reason: "disabled",
    });
    assert.include(yield* handlers["kin.approvals.keyChallenge"]().pipe(Effect.flip), {
      reason: "disabled",
    });
    const actionId = KinActionId.make("act_01");
    assert.include(yield* handlers["kin.approvals.challenge"]({ actionId }).pipe(Effect.flip), {
      reason: "disabled",
    });
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.each(["kin.approvals.challenge", "kin.approvals.submitGrant", "kin.approvals.reject"])(
  "%s needs orchestration:operate",
  (method) => {
    assert.strictEqual(requiredScopeForRpcMethod(method), AuthOrchestrationOperateScope);
  },
);
