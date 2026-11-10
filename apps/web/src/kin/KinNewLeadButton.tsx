import { useAtomValue } from "@effect/atom-react";
import type { KinHost } from "@t3tools/client-runtime/kin/kinHost";
import { Atom } from "effect/reactivity";
import { PlusIcon, SparklesIcon, UsersIcon } from "lucide-react";

import { SidebarHeaderIconButton } from "../components/sidebar/SidebarThreadHeader";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { kinClient } from "./kinClient";
import { kinGroupFormAtom } from "./kinGroupForm";
import { kinLeadFormAtom, type KinLeadFormTarget } from "./kinLeadForm";
import { useKinHost } from "./useKinHost";

/** Where a new lead would go: the Kin host and the viewer's organization there. */
export function kinNewLeadTarget(host: KinHost): KinLeadFormTarget | null {
  if (host._tag !== "host" || !host.connected || host.probe._tag !== "ready") return null;
  const me = host.probe.orgs.me[0];
  return me === undefined
    ? null
    : { environmentId: host.environmentId, orgId: me.orgId, lead: null };
}

/** Stands in for the create permission while no Kin host is known. */
export const noKinLeadPermissionAtom = Atom.make(false).pipe(Atom.withLabel("kin:no-lead-create"));

export const openKinLeadForm = (target: KinLeadFormTarget) =>
  appAtomRegistry.set(kinLeadFormAtom, target);

/** The list's "+": a new group or a new lead. Hidden where this browser may make neither. */
export function KinNewLeadButton() {
  const target = kinNewLeadTarget(useKinHost());
  if (target === null) return null;
  return <PermittedNewLeadButton target={target} />;
}

function PermittedNewLeadButton(props: { readonly target: KinLeadFormTarget }) {
  const { environmentId, orgId } = props.target;
  const canAddLead = useAtomValue(kinClient.leadCreate.permissionAtom(environmentId));
  const canAddGroup = useAtomValue(kinClient.groupCreate.permissionAtom(environmentId));
  if (!canAddLead && !canAddGroup) return null;
  return (
    <Menu>
      <MenuTrigger render={<SidebarHeaderIconButton label="New group or lead" />}>
        <PlusIcon />
      </MenuTrigger>
      <MenuPopup align="end">
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
            <SparklesIcon />
            New lead
          </MenuItem>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}
