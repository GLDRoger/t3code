import { kinNow } from "@t3tools/client-runtime/kin/kinNow";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import {
  KIN_CLIENTS,
  KIN_TOUCH_KINDS,
  kinLocalDay,
  kinTouchAt,
  type KinTouchView,
} from "@t3tools/client-runtime/kin/kinWorkClients";
import type { KinRecordKey, KinTouchKind } from "@t3tools/contracts";
import { PlusIcon, XIcon } from "lucide-react";
import { useId, useState } from "react";

import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Textarea } from "../components/ui/textarea";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import { randomUUID } from "../lib/utils";
import { useAtomCommand } from "../state/use-atom-command";
import { KinWorkSection } from "./KinWorkParts";
import { kinClient } from "./kinClient";
import type { KinWorkTarget } from "./useKinWork";

/** A client's last few contacts, with a way to log one by hand and take a logged one back. */
export function KinClientContact(
  props: KinWorkTarget & {
    readonly clientKey: KinRecordKey;
    readonly touches: ReadonlyArray<KinTouchView>;
    readonly lastContact: string | null;
    readonly canChange: boolean;
    readonly onChanged: () => void;
  },
) {
  const [adding, setAdding] = useState(false);
  const remove = useAtomCommand(kinClient.workTouchRemove, { reportFailure: false });
  const [removing, setRemoving] = useState<string | null>(null);
  const take = async (id: string) => {
    setRemoving(id);
    await remove({
      environmentId: props.environmentId,
      input: { orgId: props.orgId, touchId: id },
    });
    setRemoving(null);
    props.onChanged();
  };
  return (
    <KinWorkSection
      title={KIN_CLIENTS.recentContact}
      fold={{
        summary: props.lastContact,
      }}
      action={
        props.canChange ? (
          <Button size="xs" variant="ghost" onClick={() => setAdding(true)}>
            <PlusIcon />
            {KIN_CLIENTS.logContact}
          </Button>
        ) : undefined
      }
    >
      {props.touches.length === 0 ? (
        <p className="text-sm text-muted-foreground">{KIN_CLIENTS.noTouches}</p>
      ) : (
        <ul className="flex flex-col">
          {props.touches.map((touch) => (
            <li
              key={touch.id}
              className="flex items-start gap-3 border-b border-border/60 py-1.5 last:border-b-0"
            >
              <span className="w-16 shrink-0 pt-0.5 text-xs text-muted-foreground tabular-nums">
                {touch.when}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-sm text-foreground">{touch.title}</span>
                {touch.note === null ? null : (
                  <span className="whitespace-pre-wrap text-xs text-muted-foreground">
                    {touch.note}
                  </span>
                )}
              </span>
              {props.canChange && touch.removable ? (
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`${KIN_CLIENTS.touchRemove}: ${touch.title}, ${touch.when}`}
                  disabled={removing === touch.id}
                  onClick={() => void take(touch.id)}
                >
                  <XIcon />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {adding ? (
        <TouchDialog
          {...props}
          onSaved={() => {
            setAdding(false);
            props.onChanged();
          }}
          onClose={() => setAdding(false)}
        />
      ) : null}
    </KinWorkSection>
  );
}

function TouchDialog(
  props: KinWorkTarget & {
    readonly clientKey: KinRecordKey;
    readonly onSaved: () => void;
    readonly onClose: () => void;
  },
) {
  const log = useAtomCommand(kinClient.workTouchLog, { reportFailure: false });
  const [requestId] = useState(randomUUID);
  const [kind, setKind] = useState<KinTouchKind>("call");
  const [today] = useState(() => kinLocalDay(kinNow()));
  const [day, setDay] = useState(today);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const ids = { note: useId(), day: useId() };
  const save = async () => {
    if (saving || note.trim() === "") return;
    setSaving(true);
    setFailed(null);
    const at = kinTouchAt(day, kinNow());
    const result = await log({
      environmentId: props.environmentId,
      input: {
        orgId: props.orgId,
        party: props.clientKey,
        kind,
        note: note.trim(),
        ...(at === undefined ? {} : { at }),
        clientRequestId: requestId,
      },
    });
    setSaving(false);
    if (result._tag === "Success") props.onSaved();
    else setFailed(kinFailureText(squashAtomCommandFailure(result), KIN_CLIENTS.touchFailed));
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) props.onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <DialogHeader>
            <DialogTitle>{KIN_CLIENTS.logContact}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              <ToggleGroup
                aria-label={KIN_CLIENTS.touchKind}
                value={[kind]}
                onValueChange={(value) => {
                  const next = KIN_TOUCH_KINDS.find((option) => option.id === value[0]);
                  if (next !== undefined) setKind(next.id);
                }}
              >
                {KIN_TOUCH_KINDS.map((option) => (
                  <Toggle key={option.id} value={option.id}>
                    {option.label}
                  </Toggle>
                ))}
              </ToggleGroup>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={ids.note}>{KIN_CLIENTS.touchNote}</Label>
                <Textarea
                  id={ids.note}
                  rows={3}
                  autoFocus
                  maxLength={4_000}
                  value={note}
                  placeholder={KIN_CLIENTS.touchNotePlaceholder}
                  onChange={(event) => setNote(event.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={ids.day}>{KIN_CLIENTS.touchWhen}</Label>
                <Input
                  id={ids.day}
                  type="date"
                  value={day}
                  max={today}
                  onChange={(event) => setDay(event.target.value)}
                />
              </div>
              {failed ? (
                <Alert variant="error">
                  <AlertDescription>{failed}</AlertDescription>
                </Alert>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || note.trim() === ""} aria-busy={saving}>
              {KIN_CLIENTS.touchSave}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
