import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as HostProcess from "@t3tools/shared/HostProcess";

import * as DesktopWebLinks from "../app/DesktopWebLinks.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import { getDesktopScheme } from "../electron/ElectronProtocol.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { isKinOsLink } from "./kinDesktopLink.ts";

/**
 * Kin's build in place of T3 Code's sign-in bridge (`@clerk/electron`): the app's own link scheme
 * and the operating system's links, and nothing else. Only Kin's join and device links are taken;
 * provider sign-in and every other T3 Code link is left alone. The shell asks before acting on one.
 */
export const make = Effect.fn("KinOsLinks.make")(function* (isDevelopment: boolean) {
  const electronApp = yield* ElectronApp.ElectronApp;
  yield* electronApp.setAsDefaultProtocolClient(getDesktopScheme(isDevelopment));

  // The operating system can hand over a link before the window and shell exist.
  const pendingLinks: Array<string> = [];
  let pendingReveal = false;
  let receive = (url: string) => void pendingLinks.push(url);
  let reveal = () => {
    pendingReveal = true;
  };
  yield* electronApp.on("open-url", (event: { preventDefault: () => void }, url: string) => {
    if (!isKinOsLink(url)) return;
    event.preventDefault();
    receive(url);
  });
  yield* electronApp.on("second-instance", (_event: unknown, argv: readonly string[]) => {
    const link = argv.find(isKinOsLink);
    if (link === undefined) reveal();
    else receive(link);
  });

  return {
    configure: Effect.gen(function* () {
      const webLinks = yield* DesktopWebLinks.DesktopWebLinks;
      const electronWindow = yield* ElectronWindow.ElectronWindow;
      const runPromise = Effect.runPromiseWith(
        yield* Effect.context<ElectronWindow.ElectronWindow | DesktopWebLinks.DesktopWebLinks>(),
      );
      receive = (url) => void runPromise(webLinks.receive(url));
      reveal = () =>
        void runPromise(
          Effect.gen(function* () {
            const main = yield* electronWindow.currentMainOrFirst;
            if (Option.isSome(main)) yield* electronWindow.reveal(main.value);
          }),
        );
      const launchLink = (yield* HostProcess.Arguments).find(isKinOsLink);
      if (launchLink !== undefined) receive(launchLink);
      for (const url of pendingLinks.splice(0)) receive(url);
      if (pendingReveal) reveal();
    }).pipe(Effect.withSpan("kin.osLinks.configure")),
  };
});
