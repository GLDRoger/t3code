import { KIN_DEVICE_COPY } from "@t3tools/client-runtime/kin/kinDevice";
import { KIN_PROFILE_COPY } from "@t3tools/client-runtime/kin/kinProfiles";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { isChatOnlySession, signOutThisBrowser } from "../../environments/primary";
import { KinBriefsSetting } from "../KinBriefs";
import { KinConfirm } from "../KinConfirm";
import { KinProfileBody, useKinMe } from "../KinProfileSheet";
import { rememberKinTeammate } from "../kinTeammateMark";
import {
  KinSettingsLoading,
  KinSettingsPage,
  KinSettingsRow,
  KinSettingsSection,
} from "./KinSettingsLayout";
import type { KinSettingsTarget } from "./kinSettingsTarget";

/** Settings → Profile: your profile, your briefs, and on a teammate's browser, Leave last. */
export function KinProfilePage(props: KinSettingsTarget) {
  const me = useKinMe(props.environmentId, props.orgId);
  return (
    <KinSettingsPage purpose={KIN_PROFILE_COPY.purpose}>
      {me === null ? (
        <KinSettingsSection>
          <KinSettingsLoading rows={6} />
        </KinSettingsSection>
      ) : (
        <KinProfileBody {...props} personId={me} afterProfile={<KinBriefsSetting {...props} />} />
      )}
      {/* A teammate's browser is a chat-only session; the owner's never is. */}
      {isChatOnlySession() ? <KinLeaveTeam /> : null}
    </KinSettingsPage>
  );
}

/**
 * The phone's Leave this team: this browser forgets the team. On the web that ends its own
 * session on the host, so a shared computer is left signed out, and shows the access-ended page.
 */
function KinLeaveTeam() {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const leave = async () => {
    setBusy(true);
    setFailed(false);
    try {
      await signOutThisBrowser();
    } catch {
      setBusy(false);
      setFailed(true);
      return;
    }
    rememberKinTeammate("left");
    window.location.assign("/pair");
  };
  return (
    <KinSettingsSection problem={failed ? KIN_LEAVE_TEAM.failed : null}>
      <KinSettingsRow
        title={KIN_LEAVE_TEAM.button}
        wrap
        detail={KIN_LEAVE_TEAM.rowDetail}
        control={
          <Button
            size="sm"
            variant="destructive-outline"
            disabled={busy}
            aria-busy={busy}
            onClick={() => setAsking(true)}
          >
            {KIN_LEAVE_TEAM.confirm}
          </Button>
        }
      />
      <KinConfirm
        ask={
          asking
            ? {
                title: KIN_LEAVE_TEAM.title,
                detail: KIN_LEAVE_TEAM.detail,
                action: KIN_LEAVE_TEAM.confirm,
                destructive: true,
              }
            : null
        }
        onConfirm={() => void leave()}
        onClose={() => setAsking(false)}
      />
    </KinSettingsSection>
  );
}

const KIN_LEAVE_TEAM = {
  button: KIN_DEVICE_COPY.leaveTeam,
  rowDetail: "This browser forgets the team and signs out.",
  title: KIN_DEVICE_COPY.leaveTeamTitle,
  detail: KIN_DEVICE_COPY.leave("browser"),
  confirm: "Leave",
  failed: "Couldn't sign this browser out. Nothing changed.",
} as const;
