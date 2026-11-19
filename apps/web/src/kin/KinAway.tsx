import { kinNow } from "@t3tools/client-runtime/kin/kinNow";
import {
  KIN_AWAY,
  kinAwayDefault,
  kinAwayLine,
  kinAwayProblem,
} from "@t3tools/client-runtime/kin/kinAway";
import { kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import { KIN_HAND_OVER, kinHandOverChoices } from "@t3tools/client-runtime/kin/kinHandOver";
import { kinWorkAssignees } from "@t3tools/client-runtime/kin/kinWork";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  KinOrgId,
  KinPersonProfile,
  KinRecordKey,
  KinWorkPrincipal,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useId, useState } from "react";

import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { toastManager } from "../components/ui/toast";
import { useAtomCommand } from "../state/use-atom-command";
import { kinClient } from "./kinClient";
import { useKinFormOpen } from "./kinOverlayParts";
import { useKinWorkDirectory } from "./useKinWork";

/**
 * Away until a day, beside working hours: who is away reads it, whoever may edit the profile sets
 * it or says they're back.
 */
export function KinAwayField(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly profile: KinPersonProfile;
  readonly mine: boolean;
  readonly mayEdit: boolean;
}) {
  const { profile } = props;
  const update = useAtomCommand(kinClient.profileUpdate, { reportFailure: false });
  const [picking, setPicking] = useKinFormOpen();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const line = kinAwayLine(profile, { mine: props.mine });
  if (line === null && !props.mayEdit) return null;
  const save = async (awayUntil: string | null) => {
    setBusy(true);
    setProblem(null);
    const outcome = await update({
      environmentId: props.environmentId,
      input: { orgId: props.orgId, personId: profile.personId, awayUntil },
    });
    setBusy(false);
    if (AsyncResult.isSuccess(outcome)) return true;
    setProblem(kinFailureText(squashAtomCommandFailure(outcome), KIN_AWAY.failed));
    return false;
  };
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-xs font-medium text-muted-foreground">{KIN_AWAY.label}</h3>
      {line === null ? null : <p className="text-sm text-foreground">{line}</p>}
      {props.mayEdit ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setPicking(true)}>
            {line === null ? KIN_AWAY.set : KIN_AWAY.change}
          </Button>
          {line === null ? null : (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              aria-busy={busy}
              onClick={() => void save(null)}
            >
              {KIN_AWAY.back}
            </Button>
          )}
        </div>
      ) : null}
      {problem === null || picking ? null : (
        <p role="alert" className="text-xs text-destructive-foreground">
          {problem}
        </p>
      )}
      {picking ? (
        <KinAwayDialog
          profile={profile}
          mine={props.mine}
          busy={busy}
          problem={problem}
          onSave={async (day) => {
            if (await save(day)) setPicking(false);
          }}
          onClose={() => {
            setProblem(null);
            setPicking(false);
          }}
        />
      ) : null}
    </section>
  );
}

function KinAwayDialog(props: {
  readonly profile: KinPersonProfile;
  readonly mine: boolean;
  readonly busy: boolean;
  readonly problem: string | null;
  readonly onSave: (day: string) => Promise<void>;
  readonly onClose: () => void;
}) {
  const { profile } = props;
  const [day, setDay] = useState(
    () => profile.awayUntil ?? kinAwayDefault(kinNow(), profile.timeZone),
  );
  const [problem, setProblem] = useState<string | null>(null);
  const dayId = useId();
  const shown = problem ?? props.problem;
  return (
    <Dialog open onOpenChange={(open) => !open && !props.busy && props.onClose()}>
      <DialogPopup className="max-w-md">
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            const wrong = kinAwayProblem(day, kinNow(), profile.timeZone);
            setProblem(wrong);
            if (wrong === null) void props.onSave(day);
          }}
        >
          <DialogHeader>
            <DialogTitle>{KIN_AWAY.title}</DialogTitle>
            <DialogDescription>
              {props.mine ? KIN_AWAY.mineHint : KIN_AWAY.theirHint(profile.displayName)}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={dayId}>{KIN_AWAY.dayLabel}</Label>
              <Input
                id={dayId}
                type="date"
                value={day}
                onChange={(event) => setDay(event.currentTarget.value)}
              />
              {shown === null ? null : (
                <Alert variant="error">
                  <AlertDescription>{shown}</AlertDescription>
                </Alert>
              )}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={props.busy} onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={props.busy} aria-busy={props.busy}>
              {props.busy ? KIN_AWAY.saving : KIN_AWAY.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

type Counted = { readonly keys: ReadonlyArray<KinRecordKey> } | { readonly problem: string } | null;

/** What `from` holds open now, read when the dialog is asked for. */
function useKinHandOverCount(environmentId: EnvironmentId, orgId: KinOrgId) {
  const handOver = useAtomCommand(kinClient.workHandOver, { reportFailure: false });
  const [counted, setCounted] = useState<Counted>(null);
  const ask = (from: KinWorkPrincipal) => {
    setCounted(null);
    void handOver({ environmentId, input: { orgId, from, to: from, dryRun: true } }).then(
      (outcome) =>
        setCounted(
          AsyncResult.isSuccess(outcome)
            ? { keys: outcome.value.keys }
            : { problem: kinFailureText(squashAtomCommandFailure(outcome), KIN_HAND_OVER.failed) },
        ),
    );
  };
  return { counted, ask };
}

/**
 * "Give all open tasks to…": counts what `from` holds, asks once whom to, moves them all, and
 * offers Undo, which gives exactly those back.
 */
export function KinHandOverButton(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly from: KinWorkPrincipal;
  /** Null for the viewer's own tasks. */
  readonly fromName: string | null;
  readonly label?: string;
  readonly onDone?: (moved: number) => void;
}) {
  const [open, setOpen] = useKinFormOpen();
  const { counted, ask } = useKinHandOverCount(props.environmentId, props.orgId);
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="self-start"
        onClick={() => {
          ask(props.from);
          setOpen(true);
        }}
      >
        {props.label ?? (props.fromName === null ? KIN_HAND_OVER.mineAction : KIN_HAND_OVER.action)}
      </Button>
      {open ? (
        <KinHandOverDialog {...props} counted={counted} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

function KinHandOverDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly from: KinWorkPrincipal;
  readonly fromName: string | null;
  /** What they hold, once read (`useKinHandOverCount`). */
  readonly counted: Counted;
  readonly onDone?: (moved: number) => void;
  readonly onClose: () => void;
}) {
  const { environmentId, orgId, from } = props;
  const handOver = useAtomCommand(kinClient.workHandOver, { reportFailure: false });
  const directory = useKinWorkDirectory({ environmentId, orgId }, true);
  const assignees = kinWorkAssignees({ ...directory, orgId, current: from });
  const choices = kinHandOverChoices([...assignees.people, ...assignees.leads], from).filter(
    (choice) => choice.invited !== true,
  );
  const counted = props.counted !== null && "keys" in props.counted ? props.counted : null;
  const [to, setTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setProblem] = useState<string | null>(null);
  const problem =
    failed ?? (props.counted !== null && "problem" in props.counted ? props.counted.problem : null);
  const chosen = choices.find((choice) => choice.key === to) ?? null;
  const count = counted?.keys.length ?? 0;
  const give = async () => {
    if (chosen === null || counted === null || busy) return;
    setBusy(true);
    setProblem(null);
    const outcome = await handOver({
      environmentId,
      input: { orgId, from, to: chosen.principal, keys: counted.keys },
    });
    setBusy(false);
    if (!AsyncResult.isSuccess(outcome))
      return setProblem(kinFailureText(squashAtomCommandFailure(outcome), KIN_HAND_OVER.failed));
    const moved = outcome.value.keys;
    props.onDone?.(moved.length);
    props.onClose();
    const toast = toastManager.add({
      type: "success",
      // Long enough to read who took how many, and undo a move of many tasks.
      timeout: 15_000,
      title: `${KIN_HAND_OVER.done(moved.length, chosen.name)}${KIN_HAND_OVER.kept(outcome.value.kept)}`,
      ...(moved.length === 0
        ? {}
        : {
            actionProps: {
              children: KIN_HAND_OVER.undo,
              onClick: () => {
                toastManager.close(toast);
                void handOver({
                  environmentId,
                  input: { orgId, from: chosen.principal, to: from, keys: moved },
                }).then((back) =>
                  toastManager.add(
                    AsyncResult.isSuccess(back)
                      ? { type: "success", title: KIN_HAND_OVER.undone }
                      : {
                          type: "error",
                          title: kinFailureText(
                            squashAtomCommandFailure(back),
                            KIN_HAND_OVER.failed,
                          ),
                        },
                  ),
                );
              },
            },
          }),
    });
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && props.onClose()}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {counted === null
              ? props.fromName === null
                ? KIN_HAND_OVER.mineAction
                : KIN_HAND_OVER.action
              : count === 0
                ? KIN_HAND_OVER.none(props.fromName)
                : KIN_HAND_OVER.title(count, props.fromName)}
          </DialogTitle>
          {count === 0 ? (
            counted === null && problem === null ? (
              <DialogDescription>Counting…</DialogDescription>
            ) : null
          ) : (
            <DialogDescription>{KIN_HAND_OVER.hint}</DialogDescription>
          )}
        </DialogHeader>
        {count === 0 ? null : (
          <DialogPanel>
            <div className="flex flex-col gap-1.5">
              <Label>{KIN_HAND_OVER.pick}</Label>
              <Select
                value={to ?? ""}
                onValueChange={(value) => setTo(value === "" ? null : value)}
              >
                <SelectTrigger aria-label={KIN_HAND_OVER.pick}>
                  <SelectValue>{chosen?.name ?? KIN_HAND_OVER.pickPlaceholder}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {choices.map((choice) => (
                    <SelectItem key={choice.key} value={choice.key}>
                      {choice.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          </DialogPanel>
        )}
        {problem === null ? null : (
          <DialogPanel>
            <Alert variant="error">
              <AlertDescription>{problem}</AlertDescription>
            </Alert>
          </DialogPanel>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={props.onClose}>
            {count === 0 && counted !== null ? "Close" : "Cancel"}
          </Button>
          {count === 0 ? null : (
            <Button disabled={chosen === null || busy} aria-busy={busy} onClick={() => void give()}>
              {busy ? KIN_HAND_OVER.giving : KIN_HAND_OVER.confirm(count)}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
