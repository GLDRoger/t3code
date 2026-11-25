import type { EnvironmentId, KinOrgId } from "@t3tools/contracts";

import { KinConnectionsSettings } from "../KinConnections";
import { KinMyMailbox } from "../KinMyMailbox";
import { kinNewLeadTarget } from "../KinNewLeadButton";
import { useKinHost } from "../useKinHost";
import { useKinOwnerLevel } from "../useKinOwnerLevel";
import { KinSettingsPage } from "./KinSettingsLayout";

/**
 * Settings → Connections, on the shared anatomy; an account opens as its own page within it. A
 * teammate's holds only their own mailbox.
 */
export function KinConnectionsPage() {
  const target = kinNewLeadTarget(useKinHost());
  return target === null ? <KinConnectionsSettings /> : <ConnectionsFor {...target} />;
}

function ConnectionsFor(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
}) {
  if (useKinOwnerLevel(props.environmentId)) return <KinConnectionsSettings />;
  return (
    <KinSettingsPage>
      <KinMyMailbox environmentId={props.environmentId} orgId={props.orgId} />
    </KinSettingsPage>
  );
}
