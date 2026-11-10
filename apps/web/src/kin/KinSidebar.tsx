import { SidebarChromeFooter, SidebarChromeHeader } from "../components/sidebar/SidebarChrome";
import { SidebarContent, SidebarGroup } from "../components/ui/sidebar";
import { isElectron } from "../env";
import { KinChatList } from "./KinChatList";

/** The app sidebar while Kin is the open list: the same chrome as threads, over Kin's chats. */
export function KinSidebar() {
  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarContent
        className="min-h-full"
        fixedHeader={
          <SidebarGroup className="z-[1]">
            <h2 className="flex h-8 items-center px-2 text-sm font-medium text-sidebar-muted-foreground">
              Chats
            </h2>
          </SidebarGroup>
        }
      >
        <SidebarGroup>
          <KinChatList />
        </SidebarGroup>
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}
