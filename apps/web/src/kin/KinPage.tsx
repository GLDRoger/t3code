import { Outlet } from "@tanstack/react-router";

import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { hasDesktopWindowChrome } from "./kinDesktopWindow";
import { KinAgentPageHost } from "./KinAgentPage";
import { KinChatList } from "./KinChatList";
import { KinGroupDialogHost } from "./KinGroupDialog";
import { KinLeadDialogHost } from "./KinLeadDialog";
import { KinNewLeadButton } from "./KinNewLeadButton";
import { startKinOutbox } from "./kinOutbox";
import { KinPicturesHost } from "./kinPictures";
import { KinProfileSheetHost } from "./KinProfileSheet";
import { KinPeoplePickerHost } from "./KinPeopleChat";
import { KinMessageAlerts } from "./KinNotifications";
import { KinToday } from "./KinToday";
import { KinUpdatedLine } from "./KinUpdatedLine";
import { KinSettingsButton, KinSettingsModalHost } from "./KinSettingsView";
import { kinNewLeadTarget } from "./KinNewLeadButton";
import { useKinHost } from "./useKinHost";

/** Kin's page: the open chat. The chat list is the app sidebar (see `KinSidebar`). */
export function KinPage() {
  startKinOutbox();
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <KinUpdatedLine />
      <Outlet />
      <KinLeadDialogHost />
      <KinAgentPageHost />
      <KinGroupDialogHost />
      <KinPicturesHost />
      <KinProfileSheetHost />
      <KinPeoplePickerHost />
      <KinMessageAlerts />
      <KinSettingsModalHost />
    </SidebarInset>
  );
}

const noChat = (
  <Empty size="compact">
    <EmptyHeader>
      <EmptyTitle>No chat open</EmptyTitle>
      <EmptyDescription>Pick a chat from the list to read and reply.</EmptyDescription>
    </EmptyHeader>
  </Empty>
);

/**
 * Kin with no chat open. A narrow window has no sidebar beside the page, so the list is the page;
 * a wide one already shows it in the sidebar, so the page shows what needs you.
 */
export function KinNoChat() {
  const target = kinNewLeadTarget(useKinHost());
  return (
    <>
      <WorkspacePageHeader electron={hasDesktopWindowChrome}>
        <WorkspaceBreadcrumb ariaLabel="Kin" className="md:hidden">
          <WorkspaceBreadcrumbItem current>
            <h1 className="truncate">Chats</h1>
          </WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>
        <div className="ms-auto flex items-center gap-1 md:hidden">
          <KinSettingsButton />
          <KinNewLeadButton />
        </div>
      </WorkspacePageHeader>
      <nav aria-label="Kin chats" className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 md:hidden">
        <KinChatList />
      </nav>
      <div className="hidden min-h-0 flex-1 overflow-y-auto md:flex">
        {target === null ? (
          noChat
        ) : (
          <KinToday environmentId={target.environmentId} orgId={target.orgId} fallback={noChat} />
        )}
      </div>
    </>
  );
}
