import { contextBridge, ipcRenderer } from "electron";

import { isAppPageUrl } from "./appPage.ts";
import * as Channels from "./kinShellChannels.ts";

// Only the app's own pages get the join controls; the main process checks each call's origin.
if (isAppPageUrl(location.href)) {
  contextBridge.exposeInMainWorld("kinShell", {
    state: () => ipcRenderer.invoke(Channels.KIN_SHELL_STATE_CHANNEL),
    join: (text: string) => ipcRenderer.invoke(Channels.KIN_SHELL_JOIN_CHANNEL, text),
    retry: () => ipcRenderer.invoke(Channels.KIN_SHELL_RETRY_CHANNEL),
    useDifferentLink: () => ipcRenderer.invoke(Channels.KIN_SHELL_USE_DIFFERENT_LINK_CHANNEL),
    back: () => ipcRenderer.invoke(Channels.KIN_SHELL_BACK_CHANNEL),
  });
} else {
  contextBridge.exposeInMainWorld("kinDesktopWindow", true);
  contextBridge.exposeInMainWorld("kinDesktopReveal", () =>
    ipcRenderer.invoke(Channels.KIN_SHELL_REVEAL_CHANNEL),
  );
  // Pushed by the main process, so the page can drop the buttons' space as T3 Code's window does.
  let fullscreen = false;
  ipcRenderer.on(Channels.KIN_SHELL_FULLSCREEN_CHANNEL, (_event, value: unknown) => {
    if (typeof value === "boolean") fullscreen = value;
  });
  contextBridge.exposeInMainWorld("kinWindowFullscreen", {
    getWindowFullscreenState: () => fullscreen,
    onWindowFullscreenStateChange: (listener: (fullscreen: boolean) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, value: unknown) => {
        if (typeof value === "boolean") listener(value);
      };
      ipcRenderer.on(Channels.KIN_SHELL_FULLSCREEN_CHANNEL, wrapped);
      return () => {
        ipcRenderer.removeListener(Channels.KIN_SHELL_FULLSCREEN_CHANNEL, wrapped);
      };
    },
  });
}
