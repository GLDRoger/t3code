import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthStandardClientScopes,
  KinActionId,
  KinApprovalError,
  KinKeyThumbprint,
  KinOrgId,
  KinPersonId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Sqlite from "../../persistence/Sqlite.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import { KinIdentity, type PersonIdentity } from "../chat/KinIdentity.ts";
import { ApproverKeys } from "./ApproverKeys.ts";
import { GrantVerifier } from "./GrantVerifier.ts";
import { makeKinApprovalHandlers } from "./rpcHandlers.ts";

const session = {
  sessionId: AuthSessionId.make("session"),
  subject: "browser",
  method: "browser-session-cookie",
  scopes: AuthStandardClientScopes,
} as const;

it.effect("key and grant methods refuse as disabled when Kin is off", () =>
  Effect.gen(function* () {
    const handlers = yield* makeKinApprovalHandlers(session, Option.none());
    const orgId = KinOrgId.make("org_01");
    assert.include(yield* handlers["kin.approvals.listKeys"]({ orgId }).pipe(Effect.flip), {
      reason: "disabled",
    });
    assert.include(yield* handlers["kin.approvals.keyChallenge"]().pipe(Effect.flip), {
      reason: "disabled",
    });
    assert.include(
      yield* handlers["kin.approvals.revokeKey"]({
        orgId,
        thumbprint: KinKeyThumbprint.make("NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs"),
      }).pipe(Effect.flip),
      { reason: "disabled" },
    );
    const actionId = KinActionId.make("act_01");
    assert.include(yield* handlers["kin.approvals.challenge"]({ actionId }).pipe(Effect.flip), {
      reason: "disabled",
    });
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("only the person's own approve or reject that went through marks the card answered", () =>
  Effect.gen(function* () {
    const rhea: PersonIdentity = {
      _tag: "person",
      orgId: KinOrgId.make("org_01"),
      personId: KinPersonId.make("rhea"),
    };
    const actionId = KinActionId.make("act_01");
    const answered: Array<[ReadonlyArray<PersonIdentity>, KinActionId]> = [];
    let refuse = false;
    const refused = new KinApprovalError({ reason: "stale", message: "Refresh the card." });
    const decide = (state: "approved" | "rejected") =>
      refuse ? Effect.fail(refused) : Effect.succeed({ actionId, state });
    const services = yield* Layer.build(
      Layer.mergeAll(
        Layer.mock(KinIdentity)({
          owner: rhea,
          resolve: () => Effect.succeed([rhea]),
          isAgentThread: () => false,
          isLeadThread: () => false,
        }),
        Layer.mock(ApproverKeys)({}),
        Layer.mock(GrantVerifier)({
          submitGrant: () => decide("approved"),
          reject: () => decide("rejected"),
        }),
        Layer.mock(KinChatService)({
          answeredApproval: (people, id) => Effect.sync(() => void answered.push([people, id])),
        }),
      ),
    );
    const handlers = yield* makeKinApprovalHandlers(session, Option.some(services));
    yield* handlers["kin.approvals.submitGrant"]({ compact: "invented.grant.jws" });
    yield* handlers["kin.approvals.reject"]({ actionId, revision: 1 });
    assert.deepStrictEqual(answered, [
      [[rhea], actionId],
      [[rhea], actionId],
    ]);
    refuse = true;
    yield* handlers["kin.approvals.submitGrant"]({ compact: "invented.grant.jws" }).pipe(
      Effect.flip,
    );
    yield* handlers["kin.approvals.reject"]({ actionId, revision: 2 }).pipe(Effect.flip);
    assert.lengthOf(answered, 2);
  }).pipe(Effect.scoped, Effect.provide(Sqlite.layerMemory)),
);
