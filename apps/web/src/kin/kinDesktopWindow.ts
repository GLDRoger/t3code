import { isElectron } from "../env";

// Kin's desktop app shows the team's host without the desktop bridge; its preload marks the
// window so the page leaves room for the window buttons and drags like the full desktop app.
export const inKinDesktopWindow =
  typeof window !== "undefined" &&
  (window as { readonly kinDesktopWindow?: unknown }).kinDesktopWindow === true;

export const hasDesktopWindowChrome = isElectron || inKinDesktopWindow;
