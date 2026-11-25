import type { DesktopBridge } from "@t3tools/contracts";

import { isElectron } from "../env";

const kinWindow =
  typeof window === "undefined"
    ? undefined
    : (window as {
        readonly kinDesktopWindow?: true;
        readonly kinDesktopReveal?: () => Promise<void>;
      });

export const inKinDesktopWindow = kinWindow?.kinDesktopWindow === true;

export const revealKinDesktopWindow = () => {
  if (kinWindow?.kinDesktopReveal !== undefined) return kinWindow.kinDesktopReveal();
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
