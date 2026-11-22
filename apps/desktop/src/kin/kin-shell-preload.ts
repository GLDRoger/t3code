import { contextBridge, ipcRenderer } from "electron";

import * as Channels from "./kinShellChannels.ts";

// This preload also runs on the team's host, which gets nothing: only the app's own pages get the
// shell's controls, and the main process checks every call's origin again (DesktopIpc).
if (location.host === "app" && location.protocol !== "http:" && location.protocol !== "https:") {
  contextBridge.exposeInMainWorld("kinShell", {
    state: () => ipcRenderer.invoke(Channels.KIN_SHELL_STATE_CHANNEL),
    join: (text: string) => ipcRenderer.invoke(Channels.KIN_SHELL_JOIN_CHANNEL, text),
    retry: () => ipcRenderer.invoke(Channels.KIN_SHELL_RETRY_CHANNEL),
    useDifferentLink: () => ipcRenderer.invoke(Channels.KIN_SHELL_USE_DIFFERENT_LINK_CHANNEL),
    back: () => ipcRenderer.invoke(Channels.KIN_SHELL_BACK_CHANNEL),
  });
}
