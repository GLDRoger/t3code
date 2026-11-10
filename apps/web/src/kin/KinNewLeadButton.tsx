import { useAtomValue } from "@effect/atom-react";
import type { KinHost } from "@t3tools/client-runtime/kin/kinHost";
import { Atom } from "effect/reactivity";
import { PlusIcon } from "lucide-react";

import { SidebarHeaderIconButton } from "../components/sidebar/SidebarThreadHeader";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { kinClient } from "./kinClient";
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

/** Opens the new-lead form. Hidden where this browser may not create one. */
export function KinNewLeadButton() {
  const target = kinNewLeadTarget(useKinHost());
  if (target === null) return null;
  return <PermittedNewLeadButton target={target} />;
}

function PermittedNewLeadButton(props: { readonly target: KinLeadFormTarget }) {
  const allowed = useAtomValue(kinClient.leadCreate.permissionAtom(props.target.environmentId));
  if (!allowed) return null;
  return (
    <SidebarHeaderIconButton label="New lead" onClick={() => openKinLeadForm(props.target)}>
      <PlusIcon />
    </SidebarHeaderIconButton>
  );
}
