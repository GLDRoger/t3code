import type { DesktopBridge } from "@t3tools/contracts";

import { isElectron } from "../env";

// Kin's desktop app shows the team's host without the desktop bridge; its preload marks the
// window so the page leaves room for the window buttons and drags like the full desktop app.
export const inKinDesktopWindow =
  typeof window !== "undefined" &&
  (window as { readonly kinDesktopWindow?: unknown }).kinDesktopWindow === true;

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
