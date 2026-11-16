// @effect-diagnostics nodeBuiltinImport:off -- resolves playwright-core the way ServerBrowserContexts loads it.
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

import { KinChatError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { PreviewBrowser } from "../../preview/PreviewBrowser.ts";
import type { WorkerBrowser } from "./workerBrief.ts";

const requireHere = NodeModule.createRequire(import.meta.url);

/** The server's own playwright-core, which a worker's commands may read. */
export const playwrightCoreDir = (): string | undefined => {
  try {
    return NodePath.dirname(requireHere.resolve("playwright-core/package.json"));
  } catch {
    return undefined;
  }
};

/** Where `PreviewBrowser` keeps every Chrome build it installed. */
export const chromeBuildsDir = (baseDir: string) =>
  NodePath.join(baseDir, "tools", "chrome-headless-shell");

const STILL =
  "Nothing started. Say so once, in one line. You can still review the PR's code with a plain review.";

/**
 * The browser a UI test worker drives: T3's preview Chrome, installed on first use, and the
 * server's playwright-core and Node. A first install that outlasts the wait carries on alone.
 */
export const workerBrowser = Effect.fn("KinWorkerBrowser.resolve")(function* (
  browser: Option.Option<PreviewBrowser["Service"]>,
) {
  const playwright = playwrightCoreDir();
  if (Option.isNone(browser) || playwright === undefined)
    return yield* new KinChatError({
      reason: "unavailable",
      message: `This host has no headless browser for workers. ${STILL}`,
    });
  const chrome = yield* browser.value.executable.pipe(
    Effect.mapError(
      (error) =>
        new KinChatError({
          reason: "unavailable",
          message:
            error._tag === "PreviewBrowserInstallingError"
              ? `Kin is fetching the headless browser for this host (once, about 130 MB). ${STILL} Try again in a few minutes.`
              : error._tag === "PreviewBrowserUnsupportedError"
                ? `There is no headless browser build for this host's platform. ${STILL}`
                : `Kin couldn't install the headless browser on this host. ${STILL}`,
        }),
    ),
  );
  return {
    node: yield* HostProcess.ExecutablePath,
    playwright,
    chrome,
  } satisfies WorkerBrowser;
});
