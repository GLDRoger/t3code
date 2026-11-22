import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as DesktopApplicationMenu from "../window/DesktopApplicationMenu.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import { KinShell } from "./KinShell.ts";

/** The menu of a window on the team's Kin: editing, viewing and the way to another link. */
export const layer = Layer.effect(
  DesktopApplicationMenu.DesktopApplicationMenu,
  Effect.gen(function* () {
    const electronMenu = yield* ElectronMenu.ElectronMenu;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    const shell = yield* KinShell;
    const runPromise = Effect.runPromiseWith(yield* Effect.context<ElectronMenu.ElectronMenu>());
    const run = (effect: Effect.Effect<void>) => () => void runPromise(effect);
    const differentLink: Electron.MenuItemConstructorOptions = {
      label: "Use a Different Link…",
      click: run(shell.useDifferentLink),
    };
    const signOut: Electron.MenuItemConstructorOptions = {
      label: "Sign Out…",
      click: run(shell.signOut),
    };

    return DesktopApplicationMenu.DesktopApplicationMenu.of({
      configure: Effect.gen(function* () {
        const template: Electron.MenuItemConstructorOptions[] = [];
        if (environment.platform === "darwin") {
          template.push({
            label: environment.displayName,
            submenu: [
              { role: "about" },
              { type: "separator" },
              differentLink,
              signOut,
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          });
        } else {
          template.push({
            label: "File",
            submenu: [differentLink, signOut, { type: "separator" }, { role: "quit" }],
          });
        }
        template.push(
          { role: "editMenu" },
          {
            label: "View",
            submenu: [
              {
                label: "Reload",
                accelerator: "CmdOrCtrl+R",
                click: run(desktopWindow.runMainContentsCommand("reload")),
              },
              { type: "separator" },
              {
                label: "Actual Size",
                accelerator: "CmdOrCtrl+0",
                click: run(desktopWindow.zoomMain("reset")),
              },
              {
                label: "Zoom In",
                accelerator: "CmdOrCtrl+Plus",
                click: run(desktopWindow.zoomMain("in")),
              },
              {
                label: "Zoom Out",
                accelerator: "CmdOrCtrl+-",
                click: run(desktopWindow.zoomMain("out")),
              },
              { type: "separator" },
              { role: "togglefullscreen" },
            ],
          },
          { role: "windowMenu" },
          {
            role: "help",
            submenu: [
              {
                label: "Open Your Team's Kin in the Browser",
                click: run(shell.openHostInBrowser),
              },
            ],
          },
        );
        yield* electronMenu.setApplicationMenu(template);
      }),
    });
  }),
);
