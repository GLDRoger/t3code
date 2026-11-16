import { KIN_RETRY } from "@t3tools/client-runtime/kin/kinAnswers";
import { useAtomValue } from "@effect/atom-react";
import { KIN_USE_THIS_HOST, kinStandInLine } from "@t3tools/client-runtime/kin/kinHost";
import type { EnvironmentId } from "@t3tools/contracts";

import { Button } from "../components/ui/button";
import { environmentCatalog } from "../connection/catalog";
import { environmentPresentations } from "../state/presentation";
import { useAtomCommand } from "../state/use-atom-command";
import { chooseKinHost, kinCachedOrgs, useKinHost } from "./useKinHost";
import { useKinOwnerLevel } from "./useKinOwnerLevel";

const NO_HOST = "" as EnvironmentId;

/**
 * "Showing Studio Mac. Office Mac can't be reached." while another computer's Kin stands in, with
 * a retry for the usual one and a way to make the one showing the usual one. `environmentId` limits it to a view showing that computer's Kin.
 */
export function KinStandInLine(props: {
  readonly environmentId?: EnvironmentId;
  readonly className?: string;
}) {
  const host = useKinHost();
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const retry = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });
  const ownerLevel = useKinOwnerLevel(host._tag === "host" ? host.environmentId : NO_HOST);
  const line = kinStandInLine(
    host,
    (id) => presentations.get(id)?.entry.target.label ?? null,
    ownerLevel,
    host._tag === "host" && host.standInFor !== undefined ? kinCachedOrgs(host.standInFor) : null,
  );
  if (line === null || host._tag !== "host") return null;
  if (props.environmentId !== undefined && props.environmentId !== host.environmentId) return null;
  return (
    <p role="status" className={props.className}>
      {line.message}{" "}
      <Button size="xs" variant="link" onClick={() => void retry(line.usual)}>
        {KIN_RETRY}
      </Button>{" "}
      <Button size="xs" variant="link" onClick={() => chooseKinHost(line.shown)}>
        {KIN_USE_THIS_HOST}
      </Button>
    </p>
  );
}
