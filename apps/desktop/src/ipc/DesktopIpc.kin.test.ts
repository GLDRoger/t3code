import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import { getDesktopUrl } from "../electron/ElectronProtocol.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopIpc from "./DesktopIpc.ts";

// Kin's window shows the team's host in the main frame; only the app's own pages get IPC.
it.effect("refuses the main window's top frame once it shows another origin", () =>
  Effect.gen(function* () {
    const mainFrame = { url: "" };
    const invoke = new Map<string, DesktopIpc.DesktopIpcHandleListener>();
    const sync = new Map<string, DesktopIpc.DesktopIpcSyncListener>();
    const ipc = yield* DesktopIpc.DesktopIpc.pipe(
      Effect.provide(
        DesktopIpc.layer({
          removeHandler: (channel) => void invoke.delete(channel),
          handle: (channel, listener) => void invoke.set(channel, listener),
          removeAllListeners: (channel) => void sync.delete(channel),
          on: (channel, listener) => void sync.set(channel, listener),
        }).pipe(
          Layer.provide(
            Layer.mock(ElectronWindow.ElectronWindow, {
              main: Effect.succeedSome({
                webContents: { id: 1, mainFrame },
              } as unknown as Electron.BrowserWindow),
            }),
          ),
        ),
      ),
    );
    yield* ipc.handle(
      DesktopIpc.makeIpcMethod({
        channel: "desktop:pick-folder",
        payload: Schema.Void,
        result: Schema.String,
        handler: () => Effect.succeed("/Users/rhea"),
      }),
    );
    yield* ipc.handleSync({ channel: "token-sync", handler: () => Effect.succeed("secret") });

    const pages = {
      appPage: `${getDesktopUrl(false)}`,
      appPageInDevelopment: `${getDesktopUrl(true)}settings`,
      teamHost: "https://kin.ambermill.example/kin",
      localHost: "http://127.0.0.1:3773/kin",
      otherSite: "https://evil.example/",
      fileUrl: "file:///Users/rhea/index.html",
      errorPage: "chrome-error://chromewebdata/",
    };
    const results: Record<string, unknown> = {};
    for (const [name, url] of Object.entries(pages)) {
      mainFrame.url = url;
      const sender = { sender: { id: 1 }, senderFrame: mainFrame };
      const event = { ...sender, returnValue: "unset" as unknown };
      sync.get("token-sync")!(event);
      results[name] = [
        yield* Effect.promise(() =>
          Promise.resolve(invoke.get("desktop:pick-folder")!(sender, undefined)).catch(
            (error: unknown) => (error instanceof Error ? error.message : "rejected"),
          ),
        ),
        event.returnValue,
      ];
    }
    const refused = "Rejected desktop:pick-folder from a sender that is not the app window.";
    assert.deepEqual(results, {
      appPage: ["/Users/rhea", "secret"],
      appPageInDevelopment: ["/Users/rhea", "secret"],
      teamHost: [refused, undefined],
      localHost: [refused, undefined],
      otherSite: [refused, undefined],
      fileUrl: [refused, undefined],
      errorPage: [refused, undefined],
    });
  }),
);
