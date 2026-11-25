import type { DesktopBridge } from "@t3tools/contracts";

import { isElectron } from "../env";

type KinDesktopWindow = { readonly kinWindowReveal: () => Promise<void> };

const kinWindow =
  typeof window === "undefined"
    ? undefined
    : (window as { readonly kinDesktopWindow?: true | KinDesktopWindow }).kinDesktopWindow;

export const inKinDesktopWindow = kinWindow !== undefined;

export const revealKinDesktopWindow = () => {
  if (typeof kinWindow === "object") return kinWindow.kinWindowReveal();
  if (window.desktopBridge !== undefined) return window.desktopBridge.revealWindow();
  window.focus();
};

export const hasDesktopWindowChrome = isElectron || inKinDesktopWindow;

type WindowFullscreenSource = Pick<
  DesktopBridge,
  "getWindowFullscreenState" | "onWindowFullscreenStateChange"
>;

/** Kin's window reports full screen the way T3 Code's bridge does, so the page drops the gap. */
export const kinWindowFullscreen: WindowFullscreenSource | null = inKinDesktopWindow
  ? ((window as { readonly kinWindowFullscreen?: WindowFullscreenSource }).kinWindowFullscreen ??
    null)
  : null;
