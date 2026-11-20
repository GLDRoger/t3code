import { kinNow } from "@t3tools/client-runtime/kin/kinNow";
import {
  KIN_GOALS,
  kinGoalDraft,
  kinGoalView,
  kinGoalsSummary,
  type KinGoalDraft,
} from "@t3tools/client-runtime/kin/kinAttention";
import {
  type EnvironmentId,
  KIN_GOAL_MEASURES,
  type KinGoal,
  type KinGoalMeasure,
} from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";
import { useId, useState } from "react";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { cn, randomUUID } from "../lib/utils";
import { KinCountryFirstField } from "./KinCountryFirst";
import { Field, FormShell } from "./KinWorkForms";
import { KinWorkSection } from "./KinWorkParts";
import { useNowMinuteMs } from "./useKinClock";
import { useKinGoals } from "./useKinAttention";
import type { KinWorkTarget } from "./useKinWork";

type Goals = ReturnType<typeof useKinGoals>;

/** A goal's bar: how far it has got, with a tick where the straight line to its date is today. */
function GoalBar(props: {
  readonly progress: number;
  readonly pace: number;
  readonly behind: boolean;
}) {
  return (
    <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
      <div
        className={cn(
          "absolute inset-y-0 start-0 rounded-full",
          props.behind ? "bg-warning" : "bg-primary",
        )}
        style={{ width: `${props.progress * 100}%` }}
      />
      {props.pace > 0 && props.pace < 1 ? (
        <div
          className="absolute inset-y-0 w-0.5 bg-foreground/50"
          style={{ insetInlineStart: `${props.pace * 100}%` }}
        />
      ) : null}
    </div>
  );
}

/** The company's goals, one folded line in Money that opens to each against its line. */
export function KinGoals(props: KinWorkTarget & { readonly goals?: Goals }) {
  const own = useKinGoals(props, { enabled: props.goals === undefined });
  const goals = props.goals ?? own;
  const now = new Date(useNowMinuteMs());
  const [editing, setEditing] = useState<KinGoal | "new" | null>(null);
  if (goals.state._tag !== "ready") return null;
  const list = goals.state.value.goals;
  if (list.length === 0 && !goals.canSave) return null;
  const sheet =
    editing === null ? null : (
      <KinGoalSheet
        environmentId={props.environmentId}
        goal={editing === "new" ? null : editing}
        goals={goals}
        onClose={() => setEditing(null)}
      />
    );
  // Absent with none: Money's Add makes the first one.
  if (list.length === 0) return null;
  return (
    <KinWorkSection
      title={KIN_GOALS.title}
      fold={{ summary: kinGoalsSummary(list.map((goal) => kinGoalView(goal, now))) }}
      action={
        goals.canSave ? (
          <Button size="xs" variant="ghost" onClick={() => setEditing("new")}>
            <PlusIcon />
            {KIN_GOALS.add}
          </Button>
        ) : undefined
      }
    >
      <ul className="flex flex-col gap-1">
        {list.map((goal) => {
          const view = kinGoalView(goal, now);
          const body = (
            <>
              <span className="flex items-baseline justify-between gap-3">
                <span className="truncate text-sm text-foreground">{view.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {view.figure}
                </span>
              </span>
              <GoalBar
                progress={view.progress}
                pace={view.pace}
                behind={view.status === "behind"}
              />
              <span
                className={cn(
                  "text-xs",
                  view.status === "behind" ? "text-warning-foreground" : "text-muted-foreground",
                )}
              >
                {[
                  view.status === "behind"
                    ? KIN_GOALS.behind
                    : view.status === "reached"
                      ? KIN_GOALS.reachedLabel
                      : null,
                  view.detail || null,
                ]
                  .filter((part) => part !== null)
                  .join(" · ")}
              </span>
            </>
          );
          return (
            <li key={goal.key}>
              {goals.canSave ? (
                <button
                  type="button"
                  onClick={() => setEditing(goal)}
                  className="flex w-full flex-col gap-1.5 rounded-md px-2 py-2 text-start outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset"
                >
                  {body}
                </button>
              ) : (
                <div className="flex flex-col gap-1.5 px-2 py-2">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
      {sheet}
    </KinWorkSection>
  );
}

/** Add or change a goal: what it measures, its target and its dates. */
export function KinGoalSheet(props: {
  readonly environmentId: EnvironmentId;
  readonly goal: KinGoal | null;
  readonly goals: Goals;
  readonly onClose: () => void;
}) {
  const { goal } = props;
  const [requestId] = useState(randomUUID);
  const [draft, setDraft] = useState<KinGoalDraft>(() => kinGoalDraft(goal, kinNow()));
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const ids = {
    name: useId(),
    measure: useId(),
    target: useId(),
    current: useId(),
    unit: useId(),
    starts: useId(),
    due: useId(),
  };
  const edit = (patch: Partial<KinGoalDraft>) => setDraft({ ...draft, ...patch });
  const manual = draft.measure === "manual";
  const canSave =
    draft.title.trim() !== "" &&
    draft.target.trim() !== "" &&
    draft.startsOn !== "" &&
    draft.dueOn !== "";
  const send = async (state?: "done" | "dropped") => {
    if (saving || !canSave) return;
    setSaving(true);
    setProblem(null);
    const current = Number(draft.current);
    const failed = await props.goals.save({
      ...(goal === null ? {} : { key: goal.key, rev: goal.rev }),
      title: draft.title.trim(),
      measure: draft.measure,
      target: draft.target.trim(),
      ...(manual && draft.current.trim() !== "" && Number.isFinite(current) ? { current } : {}),
      ...(manual ? { unit: draft.unit.trim() === "" ? null : draft.unit.trim() } : {}),
      startsOn: draft.startsOn,
      dueOn: draft.dueOn,
      ...(state === undefined ? {} : { state }),
      clientRequestId: requestId,
    });
    setSaving(false);
    if (failed === null) props.onClose();
    else setProblem(failed);
  };
  return (
    <FormShell
      title={goal === null ? KIN_GOALS.add : KIN_GOALS.edit}
      submit={KIN_GOALS.save}
      saving={saving}
      canSave={canSave}
      problem={problem === null ? null : { kind: "failed", text: problem }}
      onOpenExisting={() => undefined}
      onSave={() => void send()}
      onClose={props.onClose}
      aside={
        goal === null ? undefined : (
          <div className="flex gap-1">
            {goal.state === "open" ? (
              <Button
                type="button"
                variant="ghost"
                disabled={saving}
                onClick={() => void send("done")}
              >
                {KIN_GOALS.reached}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="destructive-outline"
              disabled={saving}
              onClick={() => void send("dropped")}
            >
              {KIN_GOALS.remove}
            </Button>
          </div>
        )
      }
    >
      <Field id={ids.name} label={KIN_GOALS.name}>
        <Input
          id={ids.name}
          value={draft.title}
          maxLength={200}
          autoComplete="off"
          autoFocus
          onChange={(event) => edit({ title: event.target.value })}
        />
      </Field>
      <Field id={ids.measure} label={KIN_GOALS.measure}>
        <Select
          value={draft.measure}
          onValueChange={(value) => edit({ measure: value as KinGoalMeasure })}
        >
          <SelectTrigger id={ids.measure} className="w-full min-w-0">
            <SelectValue>{KIN_GOALS.measures[draft.measure]}</SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {KIN_GOAL_MEASURES.map((measure) => (
              <SelectItem key={measure} value={measure}>
                {KIN_GOALS.measures[measure]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <KinCountryFirstField
          environmentId={props.environmentId}
          label={KIN_GOALS.target}
          money={draft.measure === "revenue_received"}
        >
          <Field id={ids.target} label={KIN_GOALS.target}>
            <Input
              id={ids.target}
              value={draft.target}
              maxLength={60}
              autoComplete="off"
              onChange={(event) => edit({ target: event.target.value })}
            />
          </Field>
        </KinCountryFirstField>
        {manual ? (
          <Field id={ids.current} label={KIN_GOALS.current}>
            <Input
              id={ids.current}
              value={draft.current}
              inputMode="decimal"
              autoComplete="off"
              onChange={(event) => edit({ current: event.target.value })}
            />
          </Field>
        ) : null}
      </div>
      {manual ? (
        <Field id={ids.unit} label={KIN_GOALS.unit}>
          <Input
            id={ids.unit}
            value={draft.unit}
            maxLength={40}
            placeholder="For example: hires"
            autoComplete="off"
            onChange={(event) => edit({ unit: event.target.value })}
          />
        </Field>
      ) : null}
      <div className="grid grid-cols-2 gap-3">
        <Field id={ids.starts} label={KIN_GOALS.startsOn}>
          <Input
            id={ids.starts}
            type="date"
            value={draft.startsOn}
            onChange={(event) => edit({ startsOn: event.target.value })}
          />
        </Field>
        <Field id={ids.due} label={KIN_GOALS.dueOn}>
          <Input
            id={ids.due}
            type="date"
            value={draft.dueOn}
            onChange={(event) => edit({ dueOn: event.target.value })}
          />
        </Field>
      </div>
    </FormShell>
  );
}
