import {
  KIN_INVITE_ACCEPT_ROUTE,
  KIN_INVITE_APP_ROUTE,
  KIN_INVITE_BROWSER_ACCEPT_ROUTE,
  KinAppScheme,
  KinInviteAcceptRequest,
  type KinInviteAppResult,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { isBrowserOriginAllowed, trustedBrowserOrigins } from "../../auth/EnvironmentAuth.ts";
import { SessionStore } from "../../auth/SessionStore.ts";
import * as ServerConfig from "../../config.ts";
import { requestUrl } from "../../requestUrl.ts";
import { KinServer } from "../KinServer.ts";
import * as People from "./KinPeople.ts";

const decodeAccept = Schema.decodeUnknownEffect(KinInviteAcceptRequest);

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const router = yield* HttpRouter.HttpRouter;
    const origins = trustedBrowserOrigins(yield* ServerConfig.ServerConfig);
    // A fork that brands its app differently sets its own scheme; Kin's app registers `kin://`.
    const appScheme = yield* Config.schema(KinAppScheme, "KIN_APP_SCHEME").pipe(
      Config.withDefault("kin"),
      Effect.catch((error) =>
        Effect.logError("Invalid KIN_APP_SCHEME; invite pages offer kin://.", error.message).pipe(
          Effect.as("kin"),
        ),
      ),
    );
    yield* router.add(
      "GET",
      KIN_INVITE_APP_ROUTE,
      Effect.gen(function* () {
        if (Option.isNone((yield* KinServer).services))
          return HttpServerResponse.empty({ status: 503 });
        const result: KinInviteAppResult = { appScheme };
        return yield* HttpServerResponse.json(result);
      }).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 500 }))),
    );
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
        const request = yield* HttpServerRequest.HttpServerRequest;
        // The cookie this sets is a session, so the request gets the checks a cookie request
        // does; a JSON body also keeps plain cross-site forms out.
        if (!isBrowserOriginAllowed(request, origins))
          return HttpServerResponse.empty({ status: 403 });
        if (
          request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !==
          "application/json"
        )
          return HttpServerResponse.empty({ status: 415 });
        const kin = yield* KinServer;
        if (Option.isNone(kin.services)) return HttpServerResponse.empty({ status: 503 });
        const input = yield* request.json.pipe(Effect.flatMap(decodeAccept));
        const secure = Option.exists(requestUrl(request), (url) => url.protocol === "https:");
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
              secure,
            }),
          );
        }).pipe(Effect.provideContext(kin.services.value));
      }).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 400 }))),
    );
  }),
);
