import { useAtomValue } from "@effect/atom-react";
import type { KinHost } from "@t3tools/client-runtime/kin/kinHost";
import { Atom } from "effect/reactivity";
import { KIN_PEOPLE_CHAT } from "@t3tools/client-runtime/kin/kinPeopleChat";
import { useRouter } from "@tanstack/react-router";
import { MessageSquareIcon, PlusIcon, BotIcon, UserPlusIcon, UsersIcon } from "lucide-react";

import { SidebarHeaderIconButton } from "../components/sidebar/SidebarThreadHeader";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { kinClient } from "./kinClient";
import { openKinPeoplePicker } from "./KinPeopleChat";
import { kinGroupFormAtom } from "./kinGroupForm";
import { kinLeadFormAtom, type KinLeadFormTarget } from "./kinLeadForm";
import { openKinSettings } from "./kinSettingsAddress";
import { kinTeamAddRequestAtom } from "./kinTeamForm";
import { kinHostTarget, useKinHost } from "./useKinHost";

/** Where a new lead would go: the Kin host and the viewer's organization there. */
export function kinNewLeadTarget(host: KinHost): KinLeadFormTarget | null {
  const target = kinHostTarget(host);
  return target === null ? null : { ...target, lead: null };
}

/** Stands in for the create permission while no Kin host is known. */
export const noKinLeadPermissionAtom = Atom.make(false).pipe(Atom.withLabel("kin:no-lead-create"));

export const openKinLeadForm = (target: KinLeadFormTarget) =>
  appAtomRegistry.set(kinLeadFormAtom, target);

/** The list's "+": a chat with a teammate for everyone; a group, an agent or a teammate by grant. */
export function KinNewLeadButton() {
  const target = kinNewLeadTarget(useKinHost());
  if (target === null) return null;
  return <PermittedNewLeadButton target={target} />;
}

function PermittedNewLeadButton(props: { readonly target: KinLeadFormTarget }) {
  const { environmentId, orgId } = props.target;
  const canAddLead = useAtomValue(kinClient.leadCreate.permissionAtom(environmentId));
  const canAddGroup = useAtomValue(kinClient.groupCreate.permissionAtom(environmentId));
  const canAddTeammate = useAtomValue(kinClient.inviteCreate.permissionAtom(environmentId));
  const router = useRouter();
  return (
    <Menu>
      <MenuTrigger render={<SidebarHeaderIconButton label="New chat, group, agent or teammate" />}>
        <PlusIcon />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuItem onClick={() => openKinPeoplePicker({ environmentId, orgId })}>
          <MessageSquareIcon />
          {KIN_PEOPLE_CHAT.newChat}
        </MenuItem>
        {canAddGroup ? (
          <MenuItem
            onClick={() =>
              appAtomRegistry.set(kinGroupFormAtom, { environmentId, orgId, chatId: null })
            }
          >
            <UsersIcon />
            New group
          </MenuItem>
        ) : null}
        {canAddLead ? (
          <MenuItem onClick={() => openKinLeadForm(props.target)}>
            <BotIcon />
            New agent
          </MenuItem>
        ) : null}
        {canAddTeammate ? (
          <MenuItem
            onClick={() => {
              appAtomRegistry.set(kinTeamAddRequestAtom, true);
              openKinSettings(router.history, "team");
            }}
          >
            <UserPlusIcon />
            Add teammate
          </MenuItem>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}
