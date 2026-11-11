import {
  KIN_INVITE_ACCEPT_ROUTE,
  KIN_INVITE_BROWSER_ACCEPT_ROUTE,
  KinInviteAcceptRequest,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { SessionStore } from "../../auth/SessionStore.ts";
import { KinServer } from "../KinServer.ts";
import * as People from "./KinPeople.ts";

const decodeAccept = Schema.decodeUnknownEffect(KinInviteAcceptRequest);

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const router = yield* HttpRouter.HttpRouter;
    yield* router.add(
      "POST",
      KIN_INVITE_ACCEPT_ROUTE,
      Effect.gen(function* () {
        const kin = yield* KinServer;
        if (Option.isNone(kin.services)) return HttpServerResponse.empty({ status: 503 });
        const input = yield* (yield* HttpServerRequest.HttpServerRequest).json.pipe(
          Effect.flatMap(decodeAccept),
        );
        const people = yield* People.make.pipe(Effect.provideContext(kin.services.value));
        const result = yield* people.accept(input);
        return yield* HttpServerResponse.json(result, { headers: { "cache-control": "no-store" } });
      }).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 400 }))),
    );
    // A browser keeps the session as the app's own cookie; script never holds the token.
    yield* router.add(
      "POST",
      KIN_INVITE_BROWSER_ACCEPT_ROUTE,
      Effect.gen(function* () {
        const kin = yield* KinServer;
        if (Option.isNone(kin.services)) return HttpServerResponse.empty({ status: 503 });
        const input = yield* (yield* HttpServerRequest.HttpServerRequest).json.pipe(
          Effect.flatMap(decodeAccept),
        );
        return yield* Effect.gen(function* () {
          const result = yield* (yield* People.make).accept(input);
          return yield* HttpServerResponse.empty({
            status: 204,
            headers: { "cache-control": "no-store" },
          }).pipe(
            HttpServerResponse.setCookie((yield* SessionStore).cookieName, result.accessToken, {
              expires: DateTime.toDate(DateTime.makeUnsafe(result.expiresAt)),
              httpOnly: true,
              path: "/",
              sameSite: "lax",
            }),
          );
        }).pipe(Effect.provideContext(kin.services.value));
      }).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 400 }))),
    );
  }),
);
