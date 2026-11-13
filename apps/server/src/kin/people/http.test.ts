import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthStandardClientScopes,
  KIN_INVITE_APP_ROUTE,
  KIN_INVITE_BROWSER_ACCEPT_ROUTE,
} from "@t3tools/contracts";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as SqlClient from "effect/sql/SqlClient";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";

import type { SessionStore } from "../../auth/SessionStore.ts";
import * as ServerConfig from "../../config.ts";
import { layerKinAuthTest, pairSession } from "../auth/ProofKeySessions.testkit.ts";
import * as Hub from "../chat/KinChatHub.ts";
import * as Repository from "../chat/KinChatRepository.ts";
import { KinIdentity, KinIdentityConfig } from "../chat/KinIdentity.ts";
import { KinServer, type Services } from "../KinServer.ts";
import * as KinPeopleHttp from "./http.ts";
import * as People from "./KinPeople.ts";

const identities = KinIdentity.layer.pipe(
  Layer.provide(
    Layer.succeed(KinIdentityConfig, {
      orgName: "Kin",
      ownerHandle: "owner",
      ownerDisplayName: "Owner",
    }),
  ),
  Layer.provideMerge(Repository.layer),
);
const layer = People.layer.pipe(
  Layer.provideMerge(Hub.layer),
  Layer.provideMerge(identities),
  Layer.provideMerge(layerKinAuthTest("kin-people-http-")),
);
const ownerSession = {
  sessionId: AuthSessionId.make("owner"),
  subject: "browser",
  method: "browser-session-cookie" as const,
  scopes: AuthStandardClientScopes,
};

it.effect(
  "a browser accepts an invite only from the app's origin, as JSON, with Secure over HTTPS",
  () =>
    Effect.gen(function* () {
      const people = yield* People.KinPeople;
      const identity = yield* KinIdentity;
      yield* pairSession(ownerSession.sessionId);
      const invite = () =>
        people
          .createInvite(ownerSession, { orgId: identity.owner.orgId, displayName: "Suraj" })
          .pipe(Effect.map((created) => JSON.stringify({ secret: created.secret })));
      const context = yield* Effect.context<
        | SqlClient.SqlClient
        | KinIdentity
        | SessionStore
        | Repository.KinChatRepository
        | Hub.KinChatHub
      >();
      // Route handlers read their services per request, from the context the server passes in.
      const routeContext = yield* Layer.build(
        Layer.mergeAll(
          Layer.succeed(KinServer)({
            taskCardUpdater: Layer.empty,
            t3GitHubCredential: Layer.empty,
            services: Option.some(context as unknown as Context.Context<Services>),
            subscribeForViewer: Option.none(),
          }),
          Layer.succeedContext(context),
        ),
      );
      const { handler, dispose } = HttpRouter.toWebHandler(
        KinPeopleHttp.layer.pipe(
          Layer.provide(
            ServerConfig.layerTest(process.cwd(), { prefix: "kin-people-http-" }).pipe(
              Layer.provide(NodeServices.layer),
            ),
          ),
          Layer.provide(HttpServer.layerServices),
        ),
        { disableLogger: true },
      );
      yield* Effect.addFinalizer(() => Effect.promise(dispose));
      const accept = (body: string, headers: Record<string, string>) =>
        Effect.promise(() =>
          handler(
            new Request(`http://kin.example${KIN_INVITE_BROWSER_ACCEPT_ROUTE}`, {
              method: "POST",
              headers: { host: "kin.example", ...headers },
              body,
            }),
            routeContext,
          ),
        );
      const json = { "content-type": "application/json" };

      // The invite page asks, with no session, which app scheme to hand the link to.
      const app = yield* Effect.promise(() =>
        handler(new Request(`http://kin.example${KIN_INVITE_APP_ROUTE}`), routeContext),
      );
      assert.equal(app.status, 200);
      assert.deepEqual(yield* Effect.promise(() => app.json()), { appScheme: "kin" });

      const forged = yield* invite();
      const crossSite = yield* accept(forged, { ...json, origin: "https://elsewhere.example" });
      assert.equal(crossSite.status, 403);
      assert.isNull(crossSite.headers.get("set-cookie"));
      const form = yield* accept(forged, {
        "content-type": "text/plain",
        origin: "http://kin.example",
      });
      assert.equal(form.status, 415);
      assert.isNull(form.headers.get("set-cookie"));

      // Neither consumed it, and plain HTTP (development, a tailnet address) keeps working.
      const plain = yield* accept(forged, { ...json, origin: "http://kin.example" });
      assert.equal(plain.status, 204);
      assert.match(plain.headers.get("set-cookie") ?? "", /HttpOnly/);
      assert.notMatch(plain.headers.get("set-cookie") ?? "", /Secure/);

      const tls = yield* accept(yield* invite(), {
        ...json,
        origin: "https://kin.example",
        "x-forwarded-proto": "https",
      });
      assert.equal(tls.status, 204);
      assert.match(tls.headers.get("set-cookie") ?? "", /Secure/);
    }).pipe(Effect.provide(layer)),
);
