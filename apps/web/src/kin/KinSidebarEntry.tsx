import { useNavigate } from "@tanstack/react-router";
import { MessagesSquareIcon } from "lucide-react";

import { SidebarMenuButton, SidebarMenuItem, useSidebar } from "../components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useKinHost } from "./useKinHost";

/** Opens Kin's chats. Shown only while a connected environment hosts Kin. */
export function KinSidebarEntry() {
  const host = useKinHost();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  if (host._tag !== "host") return null;
  const open = () => {
    if (isMobile) setOpenMobile(false);
    void navigate({ to: "/kin" });
  };
  return (
    <SidebarMenuItem className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton aria-label="Kin" onClick={open} size="icon">
              <MessagesSquareIcon />
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">Kin</TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}
