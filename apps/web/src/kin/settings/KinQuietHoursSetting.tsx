import {
  KIN_QUIET_NOTIFICATIONS,
  kinAnswersRing,
  kinQuietSource,
} from "@t3tools/client-runtime/kin/kinProfiles";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

import { Switch } from "../../components/ui/switch";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useAtomCommand } from "../../state/use-atom-command";
import { kinClient } from "../kinClient";
import { useKinProfiles } from "../kinPictures";
import { useKinMe } from "../KinProfileSheet";
import { useKinSettingsSave } from "./KinSettingsControls";
import { KinSettingsLoading, KinSettingsRow, KinSettingsSection } from "./KinSettingsLayout";
import type { KinSettingsTarget } from "./kinSettingsTarget";

/**
 * The quiet hours that hold this person's phone notifications, whose they are, and their one
 * switch: replies to what they asked still ring. The hours themselves are set in their profile.
 */
export function KinQuietHoursSetting(props: KinSettingsTarget) {
  const me = useKinMe(props.environmentId, props.orgId);
  const result = useKinProfiles(props.environmentId, props.orgId);
  const update = useAtomCommand(kinClient.profileUpdate, { reportFailure: false });
  const saving = useKinSettingsSave();
  const held = result === null ? null : Option.getOrNull(AsyncResult.value(result));
  const profile = held?.profiles.find((one) => one.personId === me) ?? null;
  if (me === null || held === null || profile === null)
    return result !== null && AsyncResult.isFailure(result) ? null : (
      <KinSettingsSection title={KIN_QUIET_NOTIFICATIONS.title}>
        <KinSettingsLoading rows={2} />
      </KinSettingsSection>
    );
  const ring = kinAnswersRing(profile);
  const change = async (answersRing: boolean) => {
    await saving.run("answers", KIN_QUIET_NOTIFICATIONS.failed, () =>
      update({
        environmentId: props.environmentId,
        input: { orgId: props.orgId, personId: me, answersRing },
      }),
    );
    appAtomRegistry.refresh(
      kinClient.profiles({ environmentId: props.environmentId, input: { orgId: props.orgId } }),
    );
  };
  return (
    <KinSettingsSection title={KIN_QUIET_NOTIFICATIONS.title} problem={saving.problem}>
      <KinSettingsRow
        title={kinQuietSource(profile, {
          companyQuiet: held.quietHours,
          isOwner: held.ownerPersonId === me,
        })}
        detail={KIN_QUIET_NOTIFICATIONS.arrive}
        wrap
      />
      <KinSettingsRow
        title={KIN_QUIET_NOTIFICATIONS.answers}
        detail={KIN_QUIET_NOTIFICATIONS.answersDetail}
        wrap
        control={
          <Switch
            aria-label={KIN_QUIET_NOTIFICATIONS.answers}
            checked={ring}
            disabled={saving.busy !== null}
            onCheckedChange={(on) => void change(on)}
          />
        }
      />
    </KinSettingsSection>
  );
}
