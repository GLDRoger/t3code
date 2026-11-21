import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  KIN_GOALS,
  kinGoalDraft,
  kinGoalView,
  kinGoalsSummary,
  type KinGoalDraft,
} from "@t3tools/client-runtime/kin/kinAttention";
import { KIN_GOAL_MEASURES, type KinGoal } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListSection } from "../../components/ui/ListSection";
import { RowPressable } from "../../components/ui/RowPressable";
import { cn } from "../../lib/cn";
import { useNowMinuteMs } from "../../lib/clock";
import { uuidv4 } from "../../lib/uuid";
import { KinCountryFirstField } from "./components/KinCountryFirst";
import { KinDayField } from "./components/KinDayField";
import { KinFoldSection, KinWorkLoading, KinWorkTextField } from "./components/KinWorkPieces";
import { FormMessage, FormShell, NO_LINK, keyParam, targetOf } from "./KinWorkFormScreens";
import { useKinGoals } from "./state/useKinAttention";
import { useKinWorkZone, type KinWorkTarget } from "./state/useKinWork";

/** A goal's bar: how far it has got, with a tick where its straight line stands today. */
function GoalBar(props: {
  readonly progress: number;
  readonly pace: number;
  readonly behind: boolean;
}) {
  return (
    <View className="h-1.5 w-full overflow-hidden rounded-full bg-subtle">
      <View
        className={cn(
          "absolute inset-y-0 left-0 rounded-full",
          props.behind ? "bg-warning-foreground" : "bg-primary",
        )}
        style={{ width: `${props.progress * 100}%` }}
      />
      {props.pace > 0 && props.pace < 1 ? (
        <View
          className="absolute inset-y-0 w-0.5 bg-foreground-muted"
          style={{ left: `${props.pace * 100}%` }}
        />
      ) : null}
    </View>
  );
}

/** The company's goals, one folded row in Money; absent with none (Money's Add makes one). */
export function KinGoals(props: KinWorkTarget & { readonly seq: number | null }) {
  const navigation = useNavigation();
  const goals = useKinGoals(props, { enabled: true, money: true });
  const now = new Date(useNowMinuteMs());
  if (goals.state._tag !== "ready") return null;
  const list = goals.state.value.goals;
  if (list.length === 0) return null;
  const base = { environmentId: String(props.environmentId), orgId: String(props.orgId) };
  const add = goals.canSave ? (
    <ListActionRow
      icon="plus"
      label={KIN_GOALS.add}
      onPress={() => navigation.navigate("KinGoalForm", base)}
    />
  ) : null;
  return (
    <KinFoldSection
      title={KIN_GOALS.title}
      summary={kinGoalsSummary(list.map((goal) => kinGoalView(goal, now)))}
    >
      {list.map((goal) => {
        const view = kinGoalView(goal, now);
        const status =
          view.status === "behind"
            ? KIN_GOALS.behind
            : view.status === "reached"
              ? KIN_GOALS.reachedLabel
              : null;
        return (
          <RowPressable
            key={goal.key}
            accessibilityRole="button"
            accessibilityLabel={`${view.title}, ${view.figure}${status === null ? "" : `, ${status}`}`}
            disabled={!goals.canSave}
            onPress={() => navigation.navigate("KinGoalForm", { ...base, goal: goal.key })}
            className="bg-grouped-card"
          >
            <View className="gap-2 px-4 py-3">
              <View className="flex-row items-baseline justify-between gap-3">
                <Text textRole="body" className="shrink text-foreground" numberOfLines={1}>
                  {view.title}
                </Text>
                <Text textRole="footnote" className="text-foreground-muted">
                  {view.figure}
                </Text>
              </View>
              <GoalBar
                progress={view.progress}
                pace={view.pace}
                behind={view.status === "behind"}
              />
              <Text
                textRole="footnote"
                className={
                  view.status === "behind" ? "text-warning-foreground" : "text-foreground-muted"
                }
              >
                {[status, view.detail || null].filter((part) => part !== null).join(" · ")}
              </Text>
            </View>
          </RowPressable>
        );
      })}
      {add}
    </KinFoldSection>
  );
}

export type KinGoalFormParams = {
  readonly environmentId: string;
  readonly orgId: string;
  readonly goal?: string;
};

/** Add or change a goal, as a sheet over Money. */
export function KinGoalFormScreen({ route }: StaticScreenProps<KinGoalFormParams>) {
  const target = targetOf(route.params);
  const key = keyParam(route.params.goal);
  const title = route.params.goal === undefined ? KIN_GOALS.add : KIN_GOALS.edit;
  if (target === null || (route.params.goal !== undefined && key === null))
    return <FormMessage title={title}>{NO_LINK}</FormMessage>;
  return <GoalFormRead {...target} goalKey={key} title={title} />;
}

function GoalFormRead(
  props: KinWorkTarget & { readonly goalKey: string | null; readonly title: string },
) {
  const goals = useKinGoals(props, { enabled: true });
  const zone = useKinWorkZone(props);
  if (goals.state._tag !== "ready" || !zone.read)
    return (
      <FormMessage title={props.title}>
        <KinWorkLoading label="Loading goals" />
      </FormMessage>
    );
  const goal =
    props.goalKey === null
      ? null
      : (goals.state.value.goals.find((one) => one.key === props.goalKey) ?? null);
  if (props.goalKey !== null && goal === null)
    return <FormMessage title={props.title}>{NO_LINK}</FormMessage>;
  return <GoalForm target={props} goal={goal} goals={goals} title={props.title} zone={zone.zone} />;
}

function GoalForm(props: {
  readonly target: KinWorkTarget;
  readonly goal: KinGoal | null;
  readonly goals: ReturnType<typeof useKinGoals>;
  readonly title: string;
  readonly zone: string | null;
}) {
  const navigation = useNavigation();
  const { goal, zone } = props;
  const [requestId] = useState(uuidv4);
  const [opened] = useState(() => new Date());
  const [draft, setDraft] = useState<KinGoalDraft>(() => kinGoalDraft(goal, opened, zone));
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const edit = (patch: Partial<KinGoalDraft>) => setDraft({ ...draft, ...patch });
  const manual = draft.measure === "manual";
  const canSave =
    draft.title.trim() !== "" &&
    draft.target.trim() !== "" &&
    /^\d{4}-\d{2}-\d{2}$/.test(draft.startsOn) &&
    /^\d{4}-\d{2}-\d{2}$/.test(draft.dueOn);
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
    if (failed === null) navigation.goBack();
    else setProblem(failed);
  };
  return (
    <FormShell
      title={props.title}
      submit={KIN_GOALS.save}
      saving={saving}
      canSave={canSave}
      problem={problem === null ? null : { kind: "failed", text: problem }}
      onSave={() => void send()}
    >
      <ListSection>
        <KinWorkTextField
          label={KIN_GOALS.name}
          value={draft.title}
          autoFocus={goal === null}
          disabled={saving}
          maxLength={200}
          onChangeText={(title) => edit({ title })}
        />
      </ListSection>
      <ListSection title={KIN_GOALS.measure}>
        {KIN_GOAL_MEASURES.map((measure) => (
          <ListChoiceRow
            key={measure}
            label={KIN_GOALS.measures[measure]}
            selected={draft.measure === measure}
            disabled={saving}
            onPress={() => edit({ measure })}
          />
        ))}
      </ListSection>
      <ListSection>
        <KinCountryFirstField
          target={props.target}
          label={KIN_GOALS.target}
          money={draft.measure === "revenue_received"}
        >
          <KinWorkTextField
            label={KIN_GOALS.target}
            value={draft.target}
            keyboard="numbers"
            disabled={saving}
            maxLength={60}
            onChangeText={(target) => edit({ target })}
          />
        </KinCountryFirstField>
        {manual ? (
          <>
            <KinWorkTextField
              label={KIN_GOALS.current}
              value={draft.current}
              keyboard="numbers"
              disabled={saving}
              maxLength={20}
              onChangeText={(current) => edit({ current })}
            />
            <KinWorkTextField
              label={KIN_GOALS.unit}
              value={draft.unit}
              disabled={saving}
              maxLength={40}
              placeholder={KIN_GOALS.unitPlaceholder}
              onChangeText={(unit) => edit({ unit })}
            />
          </>
        ) : null}
      </ListSection>
      <ListSection>
        <KinDayField
          label={KIN_GOALS.startsOn}
          day={draft.startsOn}
          zone={zone}
          now={opened}
          none={null}
          disabled={saving}
          onPick={(startsOn) => edit({ startsOn: startsOn ?? draft.startsOn })}
        />
        <KinDayField
          label={KIN_GOALS.dueOn}
          day={draft.dueOn}
          zone={zone}
          now={opened}
          none={null}
          disabled={saving}
          onPick={(dueOn) => edit({ dueOn: dueOn ?? draft.dueOn })}
        />
      </ListSection>
      {goal === null ? null : (
        <ListSection>
          {goal.state === "open" ? (
            <ListActionRow
              icon="checkmark.circle"
              label={KIN_GOALS.reached}
              disabled={saving}
              onPress={() => void send("done")}
            />
          ) : null}
          <ListActionRow
            icon="trash"
            tone="danger"
            label={KIN_GOALS.remove}
            disabled={saving}
            onPress={() => void send("dropped")}
          />
        </ListSection>
      )}
    </FormShell>
  );
}
