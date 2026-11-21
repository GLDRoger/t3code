import { Outlet, redirect } from "@tanstack/react-router";

import { AppSidebarLayout } from "../components/AppSidebarLayout";
import { CommandPalette } from "../components/CommandPalette";
import type { resolveInitialServerAuthGateState } from "../environments/primary";
import { kinListAt } from "./kinListSwitch";

type AuthGateState = Awaited<ReturnType<typeof resolveInitialServerAuthGateState>>;

/** A teammate's session lands on Kin's list; a settings address opens that page over it. */
export function redirectChatOnlyToKin(authGateState: AuthGateState, pathname: string) {
  if (
    authGateState.status === "authenticated" &&
    authGateState.chatOnly &&
    kinListAt(pathname) !== "kin"
  ) {
    throw redirect({
      to: "/kin",
      search: pathname.startsWith("/settings")
        ? { settings: pathname.split("/")[2] || "general" }
        : {},
      replace: true,
    });
  }
}

/** A teammate's session gets Kin's list and chats: no setup, thread sync or coding chrome. */
export function KinChatOnlyRoot() {
  return (
    <CommandPalette>
      <AppSidebarLayout chatOnly>
        <Outlet />
      </AppSidebarLayout>
    </CommandPalette>
  );
}
