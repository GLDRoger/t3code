import { KIN_VISUAL_FONT_ROUTE } from "@t3tools/shared/kinVisual";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { ServerConfig } from "../config.ts";
import { requestUrl } from "../requestUrl.ts";
import { pinnedFontPath } from "./gendocs/toolchain.ts";

/**
 * Kin's pinned fonts for pages: public files with nothing of anyone's in them, so no session is
 * asked for. A sealed page's origin is opaque and fonts load by CORS, hence the open origin.
 * One not fetched yet is not found, and the page falls back to the theme's font.
 */
export const layer = HttpRouter.add(
  "GET",
  `${KIN_VISUAL_FONT_ROUTE}/*`,
  Effect.gen(function* () {
    const url = requestUrl(yield* HttpServerRequest.HttpServerRequest);
    const { baseDir } = yield* ServerConfig;
    const path = Option.isNone(url)
      ? undefined
      : pinnedFontPath(baseDir, url.value.pathname.slice(`${KIN_VISUAL_FONT_ROUTE}/`.length));
    const missing = HttpServerResponse.text("Not Found", { status: 404 });
    if (path === undefined) return missing;
    return yield* HttpServerResponse.file(path, {
      headers: {
        "Content-Type": "font/ttf",
        "Cache-Control": "public, max-age=31536000, immutable",
        "Access-Control-Allow-Origin": "*",
        "X-Content-Type-Options": "nosniff",
      },
    }).pipe(Effect.orElseSucceed(() => missing));
  }),
);
