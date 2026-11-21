import { KIN_DEVICE_COPY } from "@t3tools/client-runtime/kin/kinDevice";
import { useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog";
import { Button } from "../../components/ui/button";
import { isChatOnlySession, signOutThisBrowser } from "../../environments/primary";
import { KinBriefsSetting } from "../KinBriefs";
import { KinProfileBody, useKinMe } from "../KinProfileSheet";
import { rememberKinTeammate } from "../kinTeammateMark";
import type { KinSettingsTarget } from "./kinSettingsTarget";

/** Settings → Profile: your own profile, your briefs, and on a teammate's browser, Leave. */
export function KinProfilePage(props: KinSettingsTarget) {
  const me = useKinMe(props.environmentId, props.orgId);
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6 p-4 sm:p-6">
      {me === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <KinProfileBody {...props} personId={me} />
      )}
      <KinBriefsSetting {...props} />
      {/* A teammate's browser is a chat-only session; the owner's never is. */}
      {isChatOnlySession() ? <KinLeaveTeam /> : null}
    </div>
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
    <section className="flex flex-col items-start gap-2 border-t pt-6">
      <Button size="sm" variant="destructive-outline" onClick={() => setAsking(true)}>
        {KIN_LEAVE_TEAM.button}
      </Button>
      {failed ? (
        <p role="alert" className="text-xs text-destructive-foreground">
          {KIN_LEAVE_TEAM.failed}
        </p>
      ) : null}
      <AlertDialog open={asking} onOpenChange={(open) => !busy && setAsking(open)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{KIN_LEAVE_TEAM.title}</AlertDialogTitle>
            <AlertDialogDescription>{KIN_LEAVE_TEAM.detail}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />} disabled={busy}>
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={busy}
              aria-busy={busy}
              onClick={() => {
                setAsking(false);
                void leave();
              }}
            >
              {KIN_LEAVE_TEAM.confirm}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </section>
  );
}

const KIN_LEAVE_TEAM = {
  button: KIN_DEVICE_COPY.leaveTeam,
  title: KIN_DEVICE_COPY.leaveTeamTitle,
  detail: KIN_DEVICE_COPY.leave("browser"),
  confirm: "Leave",
  failed: "Couldn't sign this browser out. Nothing changed.",
} as const;
