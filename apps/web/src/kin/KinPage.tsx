import { Outlet } from "@tanstack/react-router";

import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";
import { KinChatList } from "./KinChatList";
import { startKinOutbox } from "./kinOutbox";

/** Kin's page: the open chat. The chat list is the app sidebar (see `KinSidebar`). */
export function KinPage() {
  startKinOutbox();
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <Outlet />
    </SidebarInset>
  );
}

/**
 * Kin with no chat open. A narrow window has no sidebar beside the page, so the list is the page;
 * a wide one already shows it in the sidebar.
 */
export function KinNoChat() {
  return (
    <>
      <WorkspacePageHeader electron={isElectron}>
        <WorkspaceBreadcrumb ariaLabel="Kin" className="md:hidden">
          <WorkspaceBreadcrumbItem current>
            <h1 className="truncate">Chats</h1>
          </WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>
      </WorkspacePageHeader>
      <nav aria-label="Kin chats" className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 md:hidden">
        <KinChatList />
      </nav>
      <div className="hidden min-h-0 flex-1 md:flex">
        <Empty size="compact">
          <EmptyHeader>
            <EmptyTitle>No chat open</EmptyTitle>
            <EmptyDescription>Pick a chat from the list to read and reply.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    </>
  );
}
