import { expect, it, vi } from "vite-plus/test";

import { KIN_SHELL_REVEAL_CHANNEL } from "./kinShellChannels.ts";

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(async () => undefined), on: vi.fn() },
}));

it("keeps the boolean window marker for older host pages and exposes reveal separately", async () => {
  vi.stubGlobal("location", new URL("https://kin.ambermill.example/kin"));
  try {
    const { contextBridge, ipcRenderer } = await import("electron");
    await import("./kin-shell-preload.ts");
    const exposed = vi.mocked(contextBridge.exposeInMainWorld).mock.calls;
    expect(exposed).toContainEqual(["kinDesktopWindow", true]);
    const reveal: unknown = exposed.find(([key]) => key === "kinDesktopReveal")?.[1];
    if (typeof reveal !== "function") throw new Error("Missing reveal bridge");
    await reveal();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(KIN_SHELL_REVEAL_CHANNEL);
  } finally {
    vi.unstubAllGlobals();
  }
});
