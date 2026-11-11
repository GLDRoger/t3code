import { SidebarChromeFooter, SidebarChromeHeader } from "../components/sidebar/SidebarChrome";
import { SidebarContent, SidebarGroup } from "../components/ui/sidebar";
import { isElectron } from "../env";
import { isChatOnlySession } from "../environments/primary";
import { KinChatList } from "./KinChatList";
import { KinNewLeadButton } from "./KinNewLeadButton";

/** The app sidebar while Kin is the open list: the same chrome as threads, over Kin's chats. */
export function KinSidebar() {
  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarContent
        className="min-h-full"
        fixedHeader={
          <SidebarGroup className="z-[1]">
            <div className="flex h-8 items-center gap-1 ps-2">
              <h2 className="min-w-0 flex-1 text-sm font-medium text-sidebar-muted-foreground">
                Chats
              </h2>
              <KinNewLeadButton />
            </div>
          </SidebarGroup>
        }
      >
        <SidebarGroup>
          <KinChatList />
        </SidebarGroup>
      </SidebarContent>
      {/* Settings, pull requests and usage are the owner's; a teammate's session has none. */}
      {isChatOnlySession() ? null : <SidebarChromeFooter />}
    </>
  );
}
