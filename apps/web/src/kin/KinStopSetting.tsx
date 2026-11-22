import { KIN_STOP, KIN_STOP_REASON_MAX } from "@t3tools/client-runtime/kin/kinStop";
import { useId, useState } from "react";

import { useSearchableSetting } from "../components/settings/settingsSearch";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { kinNewLeadTarget } from "./KinNewLeadButton";
import {
  KinSettingsLoadFailed,
  KinSettingsLoading,
  KinSettingsRow,
  KinSettingsSection,
} from "./settings/KinSettingsLayout";
import { useKinHost } from "./useKinHost";
import { useKinStop } from "./useKinStop";
import type { KinWorkTarget } from "./useKinWork";

/** The company stop switch, last on the page, for an owner or co-owner; nothing where there is no Kin. */
export function KinStopSetting() {
  const target = kinNewLeadTarget(useKinHost());
  return target === null ? null : <StopSection {...target} />;
}

function StopSection(props: KinWorkTarget) {
  const searchableSetting = useSearchableSetting();
  const { row, canAct, refresh, stop, resume } = useKinStop(props);
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const reasonId = useId();
  // A teammate is told in the chat instead; the host refuses them anyway.
  if (!canAct) return null;
  const ready = row._tag === "running" || row._tag === "stopped" ? row : null;
  const action = ready?.action ?? null;
  return (
    <KinSettingsSection
      title={KIN_STOP.title}
      searchId={searchableSetting("kin-stop").id}
      problem={ready?.problem ?? null}
    >
      {row._tag === "loading" ? (
        <KinSettingsLoading rows={1} />
      ) : row._tag === "failed" ? (
        row.retry === null ? (
          <KinSettingsRow title={row.detail} wrap />
        ) : (
          <KinSettingsLoadFailed onRetry={refresh}>{row.detail}</KinSettingsLoadFailed>
        )
      ) : (
        <KinSettingsRow
          title={row.lines[0]}
          wrap
          detail={
            row.lines.length < 2 && row.reason === null ? undefined : (
              <>
                {row.lines.slice(1).map((line) => (
                  <span key={line}>{line} </span>
                ))}
                {row.reason === null ? null : <span>{row.reason}</span>}
              </>
            )
          }
          control={
            action === null ? null : (
              <Button
                size="sm"
                variant={action.kind === "stop" ? "destructive-outline" : "outline"}
                disabled={action.busy}
                onClick={() => {
                  if (action.kind === "resume") return void resume();
                  setReason("");
                  setAsking(true);
                }}
              >
                {action.label}
              </Button>
            )
          }
        />
      )}
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{KIN_STOP.ask.title}</AlertDialogTitle>
            <AlertDialogDescription>{KIN_STOP.ask.detail}</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-1.5 px-6">
            <Label htmlFor={reasonId}>{KIN_STOP.ask.reasonLabel}</Label>
            <Input
              id={reasonId}
              value={reason}
              maxLength={KIN_STOP_REASON_MAX}
              autoComplete="off"
              onChange={(event) => setReason(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">{KIN_STOP.ask.reasonHint}</p>
          </div>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              {KIN_STOP.ask.cancel}
            </AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setAsking(false);
                void stop(reason);
              }}
            >
              {KIN_STOP.ask.confirm}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </KinSettingsSection>
  );
}
