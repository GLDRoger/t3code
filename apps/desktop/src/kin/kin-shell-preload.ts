import { contextBridge, ipcRenderer } from "electron";

import { isAppPageUrl } from "./appPage.ts";
import * as Channels from "./kinShellChannels.ts";

// The team's host gets one constant, so its layout leaves room for the window buttons; only the
// app's own pages get the shell's controls, and the main process checks every call's origin again.
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
