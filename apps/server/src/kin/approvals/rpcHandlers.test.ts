import { assert, it } from "@effect/vitest";
import { AuthSessionId, AuthStandardClientScopes, KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpServerRequest from "effect/http/HttpServerRequest";

import { connectionOf, makeKinApprovalHandlers } from "./rpcHandlers.ts";

it.effect("reads the call's socket and headers from the upgrade request", () =>
  Effect.gen(function* () {
    const upgrade = HttpServerRequest.fromWeb(
      new Request("http://127.0.0.1/ws", { headers: { "X-Forwarded-For": "203.0.113.9" } }),
    ).modify({ remoteAddress: Option.some("::ffff:127.0.0.1") });
    const read = (request: HttpServerRequest.HttpServerRequest) =>
      connectionOf.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request));

    const direct = Option.getOrThrow(yield* read(upgrade));
    assert.strictEqual(direct.remoteAddress, "::ffff:127.0.0.1");
    assert.strictEqual(direct.headers["x-forwarded-for"], "203.0.113.9");
    // A proxy-rewritten remote address hides the real socket, so there's no connection to trust.
    const rewritten = upgrade.modify({
      remoteAddress: Option.some("127.0.0.1"),
      peerAddress: Option.some("10.0.0.5"),
    });
    assert.isTrue(Option.isNone(yield* read(rewritten)));
    assert.isTrue(Option.isNone(yield* connectionOf));
  }),
);

it.effect("key methods refuse as disabled when Kin is off", () =>
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
    assert.include(yield* handlers["kin.approvals.keyChallenge"]({}).pipe(Effect.flip), {
      reason: "disabled",
    });
  }),
);
