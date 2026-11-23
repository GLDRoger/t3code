import {
  KIN_NUMBERS,
  kinNumberDraft,
  type KinNumberDirectionChoice,
  type KinNumberDraft,
  type KinNumberEveryChoice,
} from "@t3tools/client-runtime/kin/kinNumbers";
import type { KinNumberDefinition } from "@t3tools/contracts";
import { useId, useState } from "react";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import { Field, FormShell } from "./KinWorkForms";
import { newNumberRequestId, useKinNumberLocale, useKinNumberSave } from "./useKinNumbers";
import type { KinWorkTarget } from "./useKinWork";

const DIRECTIONS = Object.keys(KIN_NUMBERS.directions) as ReadonlyArray<KinNumberDirectionChoice>;
const EVERIES = Object.keys(KIN_NUMBERS.everies) as ReadonlyArray<KinNumberEveryChoice>;

/** Watch a number, or change, archive or restore one: the owner level's form. */
export function KinNumberForm(
  props: KinWorkTarget & {
    readonly definition: KinNumberDefinition | null;
    readonly onClose: () => void;
    readonly onSaved?: (definition: KinNumberDefinition) => void;
  },
) {
  const { definition } = props;
  const locale = useKinNumberLocale();
  const save = useKinNumberSave(props);
  const [requestId] = useState(newNumberRequestId);
  const [draft, setDraft] = useState<KinNumberDraft>(() => kinNumberDraft(definition, locale));
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const ids = {
    name: useId(),
    unit: useId(),
    direction: useId(),
    every: useId(),
    source: useId(),
    above: useId(),
    below: useId(),
    shared: useId(),
  };
  const edit = (patch: Partial<KinNumberDraft>) => setDraft({ ...draft, ...patch });
  const typed = JSON.stringify(draft) !== JSON.stringify(kinNumberDraft(definition, locale));
  const send = async (archived?: boolean) => {
    if (saving) return;
    setSaving(true);
    setProblem(null);
    const outcome = await save({
      definition,
      draft,
      // Archive and Restore are their own requests, not a retry of the form's save.
      clientRequestId: archived === undefined ? requestId : newNumberRequestId(),
      ...(archived === undefined ? {} : { archived }),
    });
    setSaving(false);
    if (outcome.ok) {
      props.onSaved?.(outcome.value);
      props.onClose();
    } else setProblem(outcome.problem);
  };
  const optional = (label: string) => `${label} (${KIN_NUMBERS.form.optional.toLowerCase()})`;
  return (
    <FormShell
      title={definition === null ? KIN_NUMBERS.add : KIN_NUMBERS.edit}
      submit={definition === null ? KIN_NUMBERS.add : KIN_NUMBERS.save}
      saving={saving}
      canSave={draft.name.trim() !== ""}
      typed={typed}
      problem={problem === null ? null : { kind: "failed", text: problem }}
      onOpenExisting={() => undefined}
      onSave={() => void send()}
      onClose={props.onClose}
      aside={
        definition === null ? undefined : definition.archived ? (
          <Button
            type="button"
            variant="outline"
            disabled={saving}
            onClick={() => void send(false)}
          >
            {KIN_NUMBERS.restore}
          </Button>
        ) : (
          <Button
            type="button"
            variant="destructive-outline"
            disabled={saving}
            onClick={() => void send(true)}
          >
            {KIN_NUMBERS.archive}
          </Button>
        )
      }
    >
      <Field id={ids.name} label={KIN_NUMBERS.form.name}>
        <Input
          id={ids.name}
          value={draft.name}
          maxLength={200}
          autoComplete="off"
          autoFocus
          placeholder={KIN_NUMBERS.form.namePlaceholder}
          onChange={(event) => edit({ name: event.target.value })}
        />
      </Field>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field id={ids.unit} label={optional(KIN_NUMBERS.form.unit)}>
          <Input
            id={ids.unit}
            value={draft.unit}
            maxLength={40}
            autoComplete="off"
            placeholder={KIN_NUMBERS.form.unitPlaceholder}
            onChange={(event) => edit({ unit: event.target.value })}
          />
        </Field>
        <Field id={ids.every} label={KIN_NUMBERS.form.every}>
          <Select
            value={draft.every}
            onValueChange={(value) => edit({ every: value as KinNumberEveryChoice })}
          >
            <SelectTrigger id={ids.every} className="w-full min-w-0">
              <SelectValue>{KIN_NUMBERS.everies[draft.every]}</SelectValue>
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              {EVERIES.map((every) => (
                <SelectItem key={every} value={every}>
                  {KIN_NUMBERS.everies[every]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </Field>
      </div>
      <Field id={ids.direction} label={KIN_NUMBERS.form.direction}>
        <Select
          value={draft.direction}
          onValueChange={(value) => edit({ direction: value as KinNumberDirectionChoice })}
        >
          <SelectTrigger id={ids.direction} className="w-full min-w-0">
            <SelectValue>{KIN_NUMBERS.directions[draft.direction]}</SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {DIRECTIONS.map((direction) => (
              <SelectItem key={direction} value={direction}>
                {KIN_NUMBERS.directions[direction]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </Field>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field id={ids.above} label={optional(KIN_NUMBERS.form.above)}>
          <Input
            id={ids.above}
            value={draft.above}
            inputMode="decimal"
            autoComplete="off"
            onChange={(event) => edit({ above: event.target.value })}
          />
        </Field>
        <Field id={ids.below} label={optional(KIN_NUMBERS.form.below)}>
          <Input
            id={ids.below}
            value={draft.below}
            inputMode="decimal"
            autoComplete="off"
            onChange={(event) => edit({ below: event.target.value })}
          />
        </Field>
      </div>
      <Field id={ids.source} label={optional(KIN_NUMBERS.form.source)}>
        <Input
          id={ids.source}
          value={draft.source}
          maxLength={240}
          autoComplete="off"
          placeholder={KIN_NUMBERS.form.sourcePlaceholder}
          onChange={(event) => edit({ source: event.target.value })}
        />
      </Field>
      {definition?.computed === true ? null : (
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor={ids.shared}>{KIN_NUMBERS.share}</Label>
          <Switch
            id={ids.shared}
            checked={draft.shared}
            onCheckedChange={(shared) => edit({ shared: Boolean(shared) })}
          />
        </div>
      )}
    </FormShell>
  );
}
