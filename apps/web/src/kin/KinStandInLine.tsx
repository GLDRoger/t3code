import { useAtomValue } from "@effect/atom-react";
import { kinStandInLine } from "@t3tools/client-runtime/kin/kinHost";
import type { EnvironmentId } from "@t3tools/contracts";

import { Button } from "../components/ui/button";
import { environmentCatalog } from "../connection/catalog";
import { environmentPresentations } from "../state/presentation";
import { useAtomCommand } from "../state/use-atom-command";
import { useKinHost } from "./useKinHost";

/**
 * "Showing Studio Mac. Office Mac can't be reached." while another computer's Kin stands in, with
 * a retry for the usual one. `environmentId` limits it to a view showing that computer's Kin.
 */
export function KinStandInLine(props: {
  readonly environmentId?: EnvironmentId;
  readonly className?: string;
}) {
  const host = useKinHost();
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const retry = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });
  const line = kinStandInLine(host, (id) => presentations.get(id)?.entry.target.label ?? null);
  if (line === null || host._tag !== "host") return null;
  if (props.environmentId !== undefined && props.environmentId !== host.environmentId) return null;
  return (
    <p role="status" className={props.className}>
      {line.message}{" "}
      <Button size="xs" variant="link" onClick={() => void retry(line.usual)}>
        Try again
      </Button>
    </p>
  );
}
