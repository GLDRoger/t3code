import { KIN_STOP, KIN_STOP_REASON_MAX } from "@t3tools/client-runtime/kin/kinStop";
import { useId, useState } from "react";

import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
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
import { useKinHost } from "./useKinHost";
import { useKinStop } from "./useKinStop";
import type { KinWorkTarget } from "./useKinWork";

/** The company stop switch, for an owner or co-owner; nothing shows where there is no Kin. */
export function KinStopSetting() {
  const searchableSetting = useSearchableSetting();
  const target = kinNewLeadTarget(useKinHost());
  return target === null ? null : (
    <SettingsSection {...searchableSetting("kin-stop")} hideTitle>
      <StopRow {...target} />
    </SettingsSection>
  );
}

function StopRow(props: KinWorkTarget) {
  const { row, canAct, refresh, stop, resume } = useKinStop(props);
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const reasonId = useId();
  // A teammate is told in the chat instead; the host refuses them anyway.
  if (!canAct) return null;
  const description =
    row._tag === "loading" || row._tag === "failed" ? (
      row.detail
    ) : (
      <>
        {row.lines.map((line) => (
          <span key={line} className="block">
            {line}
          </span>
        ))}
        {row.reason === null ? null : <span className="block">{row.reason}</span>}
        {row.problem === null ? null : <span className="block">{row.problem}</span>}
      </>
    );
  const control =
    row._tag === "failed" ? (
      row.retry === null ? null : (
        <Button size="xs" variant="outline" onClick={refresh}>
          {row.retry}
        </Button>
      )
    ) : row._tag === "loading" || row.action === null ? null : (
      <Button
        size="xs"
        variant={row.action.kind === "stop" ? "destructive-outline" : "outline"}
        disabled={row.action.busy}
        onClick={() => {
          if (row.action?.kind === "resume") return void resume();
          setReason("");
          setAsking(true);
        }}
      >
        {row.action.label}
      </Button>
    );
  return (
    <SettingsRow title={KIN_STOP.title} description={description} control={control}>
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
    </SettingsRow>
  );
}
