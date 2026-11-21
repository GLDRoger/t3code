import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import { KIN_COMPANY, KIN_COMPANY_SETTINGS } from "@t3tools/client-runtime/kin/kinCompanyProfile";
import { kinSameTimeZone, kinZoneLabel } from "@t3tools/client-runtime/kin/kinTimeZone";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { useSearchableSetting } from "../components/settings/settingsSearch";
import { Button } from "../components/ui/button";
import { useAtomCommand } from "../state/use-atom-command";
import { kinNewLeadTarget } from "./KinNewLeadButton";
import { kinClient } from "./kinClient";
import { KinSettingsRow } from "./settings/KinSettingsLayout";
import { useKinHost } from "./useKinHost";
import { useKinOwnerLevel } from "./useKinOwnerLevel";
import type { KinWorkTarget } from "./useKinWork";

const browserZone = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
})();

/** Whether this person may set the company's time zone, so its section knows to show. */
export function useKinCanSetTimeZone(environmentId: KinWorkTarget["environmentId"]) {
  const granted = useAtomValue(kinClient.timeZoneSet.permissionAtom(environmentId));
  const ownerLevel = useKinOwnerLevel(environmentId);
  return granted && ownerLevel;
}

/** The company's time zone, one row: what check-ins, due days and the agents' times follow. */
export function KinCompanyTimeZoneSetting() {
  const searchableSetting = useSearchableSetting();
  const target = kinNewLeadTarget(useKinHost());
  return target === null ? null : (
    <div id={searchableSetting("kin-time-zone").id} tabIndex={-1} className="outline-none">
      <CompanyTimeZone {...target} />
    </div>
  );
}

function CompanyTimeZone(props: KinWorkTarget) {
  const query = { environmentId: props.environmentId, input: { orgId: props.orgId } };
  const result = useAtomValue(kinClient.workZone(query));
  const canSet = useKinCanSetTimeZone(props.environmentId);
  const set = useAtomCommand(kinClient.timeZoneSet, { reportFailure: false });
  const [state, setState] = useState<"idle" | "saving" | "failed">("idle");
  const [problem, setProblem] = useState("");
  const zone = Option.getOrNull(AsyncResult.value(result));
  if (!canSet || AsyncResult.isFailure(result) || zone === null) return null;
  const label = kinZoneLabel(zone.timeZone);
  const offer =
    browserZone !== null &&
    (zone.fromHost === true || !kinSameTimeZone(browserZone, zone.timeZone));
  return (
    <KinSettingsRow
      title={KIN_COMPANY.timeZone}
      detail={
        state === "failed" ? (
          <span role="alert" className="text-destructive-foreground">
            {problem}
          </span>
        ) : zone.fromHost === true ? (
          KIN_COMPANY_SETTINGS.timeZoneFromHost(label)
        ) : (
          KIN_COMPANY_SETTINGS.timeZoneDetail(label)
        )
      }
      control={
        offer ? (
          <Button
            size="xs"
            variant="outline"
            disabled={state === "saving"}
            onClick={() => {
              setState("saving");
              void set({ ...query, input: { orgId: props.orgId, timeZone: browserZone } }).then(
                (outcome) => {
                  if (AsyncResult.isSuccess(outcome)) return setState("idle");
                  const why = squashAtomCommandFailure(outcome);
                  setProblem(kinFailureText(why, KIN_COMPANY_SETTINGS.timeZoneFailed));
                  setState("failed");
                },
              );
            }}
          >
            {KIN_COMPANY_SETTINGS.takeZone(kinZoneLabel(browserZone))}
          </Button>
        ) : null
      }
    />
  );
}
