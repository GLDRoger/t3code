import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { requestUrl } from "../../requestUrl.ts";
import { KinServer } from "../KinServer.ts";
import { APP_SETUP_ROUTE, KinGitHubAppSetup, setupHtml } from "./appSetup.ts";

const html = (body: string, status = 200) =>
  HttpServerResponse.text(body, {
    status,
    contentType: "text/html; charset=utf-8",
    headers: {
      "cache-control": "no-store",
      // GitHub's code is in this page's URL; nothing it links to may see it.
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });

const gone = () =>
  html(
    setupHtml(
      "This set-up link has run out",
      "<p>It was used already or is over an hour old. Start again from Kin's Settings → Connections → GitHub.</p>",
    ),
    404,
  );

const respond = Effect.fn("KinGitHubAppSetup.respond")(
  function* <E, R>(
    run: (
      setup: KinGitHubAppSetup["Service"],
      url: URL,
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  ) {
    const url = requestUrl(yield* HttpServerRequest.HttpServerRequest);
    const kin = yield* Effect.serviceOption(KinServer);
    const setup = Option.flatMap(kin, (server) =>
      Option.flatMap(server.services, (services) => Context.getOption(services, KinGitHubAppSetup)),
    );
    if (Option.isNone(url) || Option.isNone(setup)) return gone();
    return yield* run(setup.value, url.value);
  },
  Effect.catchCause((cause) =>
    Effect.logWarning("Kin's GitHub App set-up page failed.", cause).pipe(
      Effect.as(
        html(
          setupHtml(
            "Kin couldn't finish setting up the App",
            "<p>Something went wrong on Kin's side. Start again from Kin's Settings → Connections → GitHub; if GitHub already made the App, delete it in GitHub's Developer settings first.</p>",
          ),
          500,
        ),
      ),
    ),
  ),
);

/**
 * GitHub's manifest flow in the owner's own browser: `new` posts the manifest to GitHub, and
 * `created` is where GitHub sends the browser back. Both answer only to a live state that an
 * owner-level call minted; the redirect spends it before the code is used.
 */
export const layer = Layer.mergeAll(
  HttpRouter.add(
    "GET",
    `${APP_SETUP_ROUTE}/new`,
    respond((setup, url) =>
      setup
        .page(url.searchParams.get("state") ?? "", url.searchParams.get("name") ?? "", url.origin)
        .pipe(Effect.map(Option.match({ onNone: gone, onSome: (page) => html(page) }))),
    ),
  ),
  HttpRouter.add(
    "GET",
    `${APP_SETUP_ROUTE}/created`,
    respond((setup, url) =>
      setup
        .complete(url.searchParams.get("state") ?? "", url.searchParams.get("code") ?? "")
        .pipe(
          Effect.map((outcome) =>
            html(
              setupHtml(
                outcome.title,
                `<p>${outcome.detail.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)}</p>${
                  outcome.link === undefined
                    ? ""
                    : `<p><a class="button" href="${outcome.link.url}" rel="noreferrer">${outcome.link.label}</a></p>`
                }`,
              ),
              outcome.ok ? 200 : 400,
            ),
          ),
        ),
    ),
  ),
);
