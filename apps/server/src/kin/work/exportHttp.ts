import { AuthSessionId, KIN_EXPORT_ROUTE, KinOrgId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { AssetSigner } from "../../assets/AssetSigner.ts";
import { SessionStore } from "../../auth/SessionStore.ts";
import { downloadContentDisposition } from "../../http.ts";
import { requestUrl } from "../../requestUrl.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { KinServer } from "../KinServer.ts";
import { exportZip, readExportToken, theOrgOwner } from "./exportBundle.ts";

const refused = () =>
  HttpServerResponse.empty({ status: 404, headers: { "cache-control": "no-store" } });

/**
 * "Download everything": the link `kin.work.exportLink` made names the org and the session it
 * was made for. Each fetch checks the signature, the session still being signed in, and that
 * session's person still being the owner, then streams the zip as it is written.
 */
export const layer = HttpRouter.add(
  "GET",
  `${KIN_EXPORT_ROUTE}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = requestUrl(request);
    if (Option.isNone(url)) return refused();
    const [token, name] = url.value.pathname.slice(`${KIN_EXPORT_ROUTE}/`.length).split("/");
    if (token === undefined || name === undefined) return refused();
    const claims = yield* readExportToken(token, yield* AssetSigner);
    if (Option.isNone(claims)) return refused();
    const kin = yield* KinServer;
    if (Option.isNone(kin.services)) return refused();
    const services = kin.services.value;
    const session = yield* (yield* SessionStore)
      .getActive(AuthSessionId.make(claims.value.reader))
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(session)) return refused();
    const orgId = KinOrgId.make(claims.value.orgId);
    const zip = yield* Effect.gen(function* () {
      const people = yield* Context.get(services, KinIdentity).resolve(session.value);
      const owner = yield* theOrgOwner(people, orgId);
      return yield* exportZip(orgId, owner.personId);
    }).pipe(Effect.provideContext(services), Effect.option);
    if (Option.isNone(zip)) return refused();
    const body = zip.value.pipe(
      Stream.tapError((cause) => Effect.logWarning("Kin export stopped part way.", cause)),
      Stream.provideContext(services),
    );
    return HttpServerResponse.stream(body, {
      contentType: "application/zip",
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": downloadContentDisposition(decodeURIComponent(name)),
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      },
    });
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Kin export refused.", cause).pipe(Effect.as(refused())),
    ),
  ),
  // The path carries a signed token; spans and request logs record it as REDACTED.
  { redactedParams: ["*"] },
);
