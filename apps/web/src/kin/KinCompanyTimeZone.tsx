import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import { KIN_COMPANY } from "@t3tools/client-runtime/kin/kinCompanyProfile";
import { kinSameTimeZone, kinZoneLabel } from "@t3tools/client-runtime/kin/kinTimeZone";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { useSearchableSetting } from "../components/settings/settingsSearch";
import { Button } from "../components/ui/button";
import { useAtomCommand } from "../state/use-atom-command";
import { kinNewLeadTarget } from "./KinNewLeadButton";
import { kinClient } from "./kinClient";
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

/** The company's time zone: what check-ins, due days and the agents' times follow. */
export function KinCompanyTimeZoneSetting() {
  const searchableSetting = useSearchableSetting();
  const target = kinNewLeadTarget(useKinHost());
  return target === null ? null : (
    <SettingsSection {...searchableSetting("kin-time-zone")} hideTitle>
      <CompanyTimeZone {...target} />
    </SettingsSection>
  );
}

function CompanyTimeZone(props: KinWorkTarget) {
  const query = { environmentId: props.environmentId, input: { orgId: props.orgId } };
  const result = useAtomValue(kinClient.workZone(query));
  const granted = useAtomValue(kinClient.timeZoneSet.permissionAtom(props.environmentId));
  const ownerLevel = useKinOwnerLevel(props.environmentId);
  const canSet = granted && ownerLevel;
  const set = useAtomCommand(kinClient.timeZoneSet, { reportFailure: false });
  const [state, setState] = useState<"idle" | "saving" | "failed">("idle");
  const [problem, setProblem] = useState("");
  const zone = Option.getOrNull(AsyncResult.value(result));
  if (!canSet || AsyncResult.isFailure(result) || zone === null) return null;
  const description =
    state === "failed"
      ? problem
      : zone.fromHost === true
        ? `None set yet, so Kin uses this computer's: ${kinZoneLabel(zone.timeZone)}. Check-ins, due days and times follow it. ${KIN_COMPANY.timeZoneFollows}`
        : `${kinZoneLabel(zone.timeZone)}. Check-ins, due days and times follow it. ${KIN_COMPANY.timeZoneFollows}`;
  const offer =
    browserZone !== null &&
    (zone.fromHost === true || !kinSameTimeZone(browserZone, zone.timeZone));
  return (
    <SettingsRow
      title="Time zone"
      description={description}
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
                  setProblem(kinFailureText(why, "The time zone wasn't saved."));
                  setState("failed");
                },
              );
            }}
          >
            Use {kinZoneLabel(browserZone)}
          </Button>
        ) : null
      }
    />
  );
}
