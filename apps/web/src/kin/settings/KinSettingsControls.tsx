import { kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import { KIN_SETTINGS_COPY } from "@t3tools/client-runtime/kin/kinSettingsSpread";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import { useId, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import { Label } from "../../components/ui/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { useKinFormDiscard } from "../KinFormDiscard";

/**
 * One choice among a few, saved the moment it is picked. `value: null` is a setting said once
 * for many things that differ: it reads "Mixed" until one value is picked for all.
 */
export function KinSettingsChoice<T extends string>(props: {
  readonly label: string;
  readonly value: T | null;
  readonly options: ReadonlyArray<{ readonly value: T; readonly label: string }>;
  readonly disabled?: boolean;
  readonly onChange: (value: T) => void;
}) {
  const shown = props.options.find((option) => option.value === props.value)?.label;
  const longest = Math.max(
    KIN_SETTINGS_COPY.mixed.length,
    ...props.options.map((option) => option.label.length),
  );
  return (
    <Select
      value={props.value}
      disabled={props.disabled}
      onValueChange={(next) => {
        const picked = props.options.find((option) => option.value === next);
        if (picked !== undefined && picked.value !== props.value) props.onChange(picked.value);
      }}
    >
      <SelectTrigger
        size="sm"
        aria-label={props.label}
        className="w-auto max-w-64 min-w-32 sm:min-w-(--kin-choice-width)"
        // From sm up, as wide as the longest choice needs (about half an em a letter), so none is
        // cut; narrower, the row's title keeps its room and a long choice truncates.
        style={
          { "--kin-choice-width": `max(10rem, calc(${longest / 2}em + 2.75rem))` } as CSSProperties
        }
      >
        <SelectValue>{shown ?? KIN_SETTINGS_COPY.mixed}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {props.options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/**
 * Instant saves: one change at a time, and the failure in the person's words until the next.
 * `run` answers whether it went through, so a control can put itself back.
 */
export function useKinSettingsSave() {
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const run = async (
    key: string,
    failed: string,
    sent: () => Promise<AtomCommandResult<unknown, unknown>>,
  ) => {
    if (busy !== null) return false;
    setBusy(key);
    setProblem(null);
    const result = await sent();
    setBusy(null);
    if (AsyncResult.isSuccess(result)) return true;
    setProblem(kinFailureText(squashAtomCommandFailure(result), failed));
    return false;
  };
  return { busy, problem, run };
}

/** A labelled field in a form: label above, the control, then one line of help. */
export function KinSettingsField(props: {
  readonly label: string;
  readonly help?: ReactNode;
  /** The name a form's `openAt` uses to open on this field. */
  readonly name?: string;
  /** Gets the control's id, and the label's id for a group (`aria-labelledby`). */
  readonly children: (ids: { readonly control: string; readonly label: string }) => ReactNode;
}) {
  const control = useId();
  const label = useId();
  return (
    <div data-kin-field={props.name} className="flex flex-col gap-1.5">
      <Label id={label} htmlFor={control}>
        {props.label}
      </Label>
      {props.children({ control, label })}
      {props.help === undefined ? null : (
        <p className="text-pretty text-xs text-muted-foreground">{props.help}</p>
      )}
    </div>
  );
}

/**
 * A form that saves on its button: text, several fields, anything a half-typed value would break.
 * `remove` sits at the footer's start for a thing's own Remove, which asks with `KinConfirm`.
 */
export function KinSettingsFormDialog(props: {
  readonly title: string;
  readonly description?: ReactNode;
  readonly submitLabel: string;
  readonly busy: boolean;
  /** Why the form can't be saved yet, said quietly; the button waits. */
  readonly notReady?: string | null;
  /** What went wrong on the last save. */
  readonly problem?: string | null;
  readonly remove?: ReactNode;
  /** Beside Cancel, for a second action on the thing: "Run now". */
  readonly secondary?: ReactNode;
  /** The `name` of the field to open on, when a row named one: "Working hours" opens there. */
  readonly openAt?: string | null;
  /** Something typed and not saved: closing asks before it is thrown away. */
  readonly typed?: boolean;
  readonly onSubmit: () => void;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const notReady = props.notReady ?? null;
  const form = useRef<HTMLFormElement>(null);
  const openAt = props.openAt ?? null;
  const discard = useKinFormDiscard(props.typed === true, props.onClose);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !props.busy) discard.close();
      }}
    >
      <DialogPopup
        className="max-w-lg"
        {...(openAt === null
          ? {}
          : {
              initialFocus: (openType: string) => kinFieldToFocus(form.current, openAt, openType),
            })}
      >
        <form
          ref={form}
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            if (!props.busy && notReady === null) props.onSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{props.title}</DialogTitle>
            {props.description === undefined ? null : (
              <DialogDescription>{props.description}</DialogDescription>
            )}
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              {props.children}
              {props.problem == null ? (
                notReady === null || notReady === "" ? null : (
                  <p className="text-xs text-muted-foreground">{notReady}</p>
                )
              ) : (
                <Alert variant="error">
                  <AlertDescription role="alert">{props.problem}</AlertDescription>
                </Alert>
              )}
            </div>
          </DialogPanel>
          <DialogFooter>
            {props.remove === undefined ? null : <div className="sm:me-auto">{props.remove}</div>}
            {props.secondary}
            <Button type="button" variant="outline" disabled={props.busy} onClick={discard.close}>
              {KIN_SETTINGS_COPY.cancel}
            </Button>
            <Button type="submit" disabled={props.busy || notReady !== null} aria-busy={props.busy}>
              {props.busy ? KIN_SETTINGS_COPY.saving : props.submitLabel}
            </Button>
          </DialogFooter>
        </form>
        {discard.ask}
      </DialogPopup>
    </Dialog>
  );
}

/**
 * A thing's own dialog whose changes save as they are made (switches, a list to add to), so it
 * closes with Done rather than Cancel and Save. `start` holds an action at the footer's start.
 */
export function KinSettingsDialog(props: {
  readonly title: string;
  readonly description?: ReactNode;
  readonly busy?: boolean;
  /** What went wrong on the last change. */
  readonly problem?: string | null;
  readonly start?: ReactNode;
  readonly secondary?: ReactNode;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && props.busy !== true) props.onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          {props.description === undefined ? null : (
            <DialogDescription>{props.description}</DialogDescription>
          )}
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            {props.children}
            {props.problem == null ? null : (
              <Alert variant="error">
                <AlertDescription role="alert">{props.problem}</AlertDescription>
              </Alert>
            )}
          </div>
        </DialogPanel>
        <DialogFooter>
          {props.start === undefined ? null : <div className="sm:me-auto">{props.start}</div>}
          {props.secondary}
          <Button type="button" disabled={props.busy === true} onClick={props.onClose}>
            {KIN_SETTINGS_COPY.done}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** The named field's first control, brought into view; a touch only scrolls, so no keyboard opens. */
function kinFieldToFocus(form: HTMLFormElement | null, name: string, openType: string) {
  const field = form?.querySelector<HTMLElement>(`[data-kin-field="${CSS.escape(name)}"]`);
  field?.scrollIntoView({ block: "nearest" });
  if (openType === "touch") return form?.closest<HTMLElement>("[data-slot=dialog-popup]") ?? true;
  if (field == null) return true;
  return (
    field.querySelector<HTMLElement>(
      "input:not([disabled]), textarea:not([disabled]), button:not([disabled]), [role=combobox]",
    ) ?? true
  );
}
