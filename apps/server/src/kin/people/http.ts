import {
  KIN_DEVICE_BROWSER_RENEW_ROUTE,
  KIN_DEVICE_RENEW_ROUTE,
  KIN_INVITE_ACCEPT_ROUTE,
  KIN_INVITE_APP_ROUTE,
  KIN_INVITE_BROWSER_ACCEPT_ROUTE,
  KinAppScheme,
  type KinDeviceRenewResult,
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
import {
  ignoresBrowserCookie,
  isBrowserOriginAllowed,
  parseBearerToken,
  trustedBrowserOrigins,
} from "../../auth/EnvironmentAuth.ts";
import { SessionStore } from "../../auth/SessionStore.ts";
import { deriveAuthClientMetadata } from "../../auth/utils.ts";
import * as ServerConfig from "../../config.ts";
import { requestUrl } from "../../requestUrl.ts";
import { KinServer } from "../KinServer.ts";
import * as People from "./KinPeople.ts";

const decodeAccept = Schema.decodeUnknownEffect(KinInviteAcceptRequest);
const noStore = { "cache-control": "no-store" };

const firstValue = (value: string | undefined) => value?.split(",")[0]?.trim().toLowerCase();

/**
 * Stricter than a cookie read: this sets a fresh session cookie, so it needs a browser's Origin.
 * That is the app's own (same-origin by the browser's word, or this host, forwarded or not, on
 * the request's own scheme) or one of the app's trusted origins.
 */
const renewOriginAllowed = (
  request: HttpServerRequest.HttpServerRequest,
  origins: ReadonlySet<string>,
) => {
  const origin = request.headers.origin;
  if (origin === undefined || ignoresBrowserCookie(request.headers, origins)) return false;
  if (origins.has(origin) || request.headers["sec-fetch-site"] === "same-origin") return true;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  const hosts = [firstValue(request.headers.host), firstValue(request.headers["x-forwarded-host"])];
  return (
    hosts.includes(parsed.host.toLowerCase()) &&
    Option.exists(requestUrl(request), (url) => url.protocol === parsed.protocol)
  );
};

/**
 * The device's own session renewed, as a response: 401 for a credential that isn't valid, 403
 * for one that isn't a live, bound teammate device, and 500 for anything else, so a client tries
 * again rather than taking a host fault as "nothing to renew".
 */
const renewDevice = Effect.fn("KinPeopleHttp.renewDevice")(function* <E>(
  token: string,
  respond: (
    renewed: KinDeviceRenewResult & { accessToken: string },
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, E>,
) {
  const kin = yield* KinServer;
  if (Option.isNone(kin.services)) return HttpServerResponse.empty({ status: 503 });
  return yield* Effect.gen(function* () {
    const verified = yield* (yield* SessionStore).verify(token).pipe(Effect.option);
    if (Option.isNone(verified)) return HttpServerResponse.empty({ status: 401 });
    const renewed = yield* (yield* People.make).renewDevice(verified.value, token);
    return Option.isNone(renewed)
      ? HttpServerResponse.empty({ status: 403 })
      : yield* respond(renewed.value);
  }).pipe(Effect.provideContext(kin.services.value));
});

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
        const request = yield* HttpServerRequest.HttpServerRequest;
        const input = yield* request.json.pipe(Effect.flatMap(decodeAccept));
        const people = yield* People.make.pipe(Effect.provideContext(kin.services.value));
        // The phone app's route: what kind of device it is isn't the body's to say.
        const result = yield* people.accept({ ...input, deviceType: "mobile" });
        return yield* HttpServerResponse.json(result, { headers: { "cache-control": "no-store" } });
      }).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 400 }))),
    );
    yield* router.add(
      "POST",
      KIN_DEVICE_RENEW_ROUTE,
      Effect.gen(function* () {
        const token = parseBearerToken(yield* HttpServerRequest.HttpServerRequest);
        if (token === null) return HttpServerResponse.empty({ status: 401 });
        return yield* renewDevice(token, (renewed) =>
          HttpServerResponse.json(renewed, { headers: noStore }),
        );
      }).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 500 }))),
    );
    // The browser's renewal: the cookie in, a fresh cookie out; script never sees the token.
    yield* router.add(
      "POST",
      KIN_DEVICE_BROWSER_RENEW_ROUTE,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (!renewOriginAllowed(request, origins)) return HttpServerResponse.empty({ status: 403 });
        const sessions = yield* SessionStore;
        const token = request.cookies[sessions.cookieName];
        if (token === undefined) return HttpServerResponse.empty({ status: 401 });
        const secure = Option.exists(requestUrl(request), (url) => url.protocol === "https:");
        return yield* renewDevice(token, (renewed) =>
          HttpServerResponse.json({ expiresAt: renewed.expiresAt }, { headers: noStore }).pipe(
            Effect.flatMap(
              HttpServerResponse.setCookie(sessions.cookieName, renewed.accessToken, {
                expires: DateTime.toDate(DateTime.makeUnsafe(renewed.expiresAt)),
                httpOnly: true,
                path: "/",
                sameSite: "lax",
                secure,
              }),
            ),
          ),
        );
      }).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 500 }))),
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
          // A browser says what it is through its user agent, not the request body.
          const deviceType = deriveAuthClientMetadata({ request }).deviceType;
          const result = yield* (yield* People.make).accept({ ...input, deviceType });
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
