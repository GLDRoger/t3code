import { kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import {
  KIN_QUIET_NOTIFICATIONS,
  kinAnswersRing,
  kinQuietSource,
} from "@t3tools/client-runtime/kin/kinProfiles";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  KinOrgId,
  KinPeopleProfilesResult,
  KinPersonId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { AppText as Text } from "../../components/ui/AppText";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { appAtomRegistry } from "../../state/atom-registry";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";
import { kinClient } from "./state/kinClient";

/**
 * The quiet hours that hold this person's notifications, whose they are, and their one switch:
 * replies to what they asked still ring. The hours themselves are set in their profile.
 */
export function KinQuietHoursRows(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly profiles: KinPeopleProfilesResult;
  readonly personId: KinPersonId;
}) {
  const update = useAtomCommand(kinClient.profileUpdate, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const profile = props.profiles.profiles.find((one) => one.personId === props.personId);
  if (profile === undefined) return null;
  const change = async (answersRing: boolean) => {
    setBusy(true);
    setProblem(null);
    const outcome = await update({
      environmentId: props.environmentId,
      input: { orgId: props.orgId, personId: profile.personId, answersRing },
    });
    setBusy(false);
    if (!AsyncResult.isSuccess(outcome))
      setProblem(kinFailureText(squashAtomCommandFailure(outcome), KIN_QUIET_NOTIFICATIONS.failed));
    appAtomRegistry.refresh(
      kinClient.profiles({ environmentId: props.environmentId, input: { orgId: props.orgId } }),
    );
  };
  return (
    <SettingsSection title={KIN_QUIET_NOTIFICATIONS.title}>
      <ListRowLayout
        icon="moon"
        label={kinQuietSource(profile, {
          companyQuiet: props.profiles.quietHours,
          isOwner: props.profiles.ownerPersonId === profile.personId,
        })}
        description={KIN_QUIET_NOTIFICATIONS.arrive}
      />
      <SettingsSwitchRow
        icon="bell.badge"
        label={KIN_QUIET_NOTIFICATIONS.answers}
        subtitle={KIN_QUIET_NOTIFICATIONS.answersDetail}
        value={kinAnswersRing(profile)}
        disabled={busy}
        onValueChange={(on) => void change(on)}
      />
      {problem === null ? null : (
        <Text textRole="footnote" className="px-4 pb-3 text-danger-foreground">
          {problem}
        </Text>
      )}
    </SettingsSection>
  );
}
