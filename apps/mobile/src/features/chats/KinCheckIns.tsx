import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  KIN_BRIEFS,
  KIN_CHECK_INS,
  KIN_WEEKDAYS,
  kinBriefProblem,
  kinBriefSheetFields,
  kinCheckInLine,
  kinCheckInPipeline,
  kinClockChoices,
  kinCoveredLine,
} from "@t3tools/client-runtime/kin/kinCheckIns";
import { KIN_SET_UP_ON_COMPUTER } from "@t3tools/client-runtime/kin/kinNavigation";
import type {
  KinCheckIn,
  KinCheckInActInput,
  KinCheckInsResult,
  KinOrgId,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListSection } from "../../components/ui/ListSection";
import { Menu } from "../../components/ui/Menu";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsRow } from "../settings/components/SettingsRow";
import { KinWorkLoading, KinWorkToggleRow } from "./components/KinWorkPieces";
import { FormMessage, FormShell, NO_LINK, targetOf } from "./KinWorkFormScreens";
import { kinClient, refreshKinBriefs } from "./state/kinClient";
import { kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

interface Target {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
}

export function useCheckIns(target: Target) {
  const atom = kinClient.checkIns({
    environmentId: target.environmentId,
    input: { orgId: target.orgId },
  });
  const result = useAtomValue(atom);
  return {
    result,
    value: Option.getOrNull(AsyncResult.value(result)),
    refresh: () => refreshKinBriefs(target.environmentId, target.orgId),
    canRead: useAtomValue(kinClient.checkInSave.permissionAtom(target.environmentId)),
  };
}

/** Check-ins as Settings rows, each opening its sheet; adding one is on the computer. */
export function KinCheckInRows(props: Target & { readonly beyond: ReadonlyArray<KinCheckIn> }) {
  const navigation = useNavigation();
  return (
    <>
      {props.beyond.map((checkIn) => (
        <SettingsRow
          labelWholeWords
          key={checkIn.scheduleId}
          icon={checkIn.on ? "clock" : "moon"}
          label={checkIn.title}
          valuePosition="below"
          value={[
            checkIn.on
              ? kinCheckInLine(checkIn)
              : `${KIN_CHECK_INS.off} · ${kinCheckInLine(checkIn)}`,
            kinCoveredLine(checkIn),
          ]
            .filter((line) => line !== null)
            .join("\n")}
          onPress={() =>
            navigation.navigate("KinCheckInForm", {
              environmentId: props.environmentId,
              orgId: props.orgId,
              checkIn: checkIn.scheduleId,
            })
          }
        />
      ))}
    </>
  );
}

export type KinCheckInFormParams = {
  readonly environmentId: string;
  readonly orgId: string;
  readonly checkIn?: string;
};

/** A brief's time from a list of half hours, never typed. */
export function KinClockRow(props: {
  readonly label: string;
  readonly at: string;
  readonly disabled: boolean;
  readonly onPick: (at: string) => void;
}) {
  return (
    <Menu
      actions={kinClockChoices(props.at).map((at) => ({
        id: at,
        title: at,
        state: at === props.at ? ("on" as const) : ("off" as const),
      }))}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event !== props.at) props.onPick(nativeEvent.event);
      }}
    >
      <SettingsRow
        labelWholeWords
        icon="clock"
        label={props.label}
        value={props.at}
        valuePosition="trailing"
        disabled={props.disabled}
      />
    </Menu>
  );
}

/** One check-in's sheet: on or off, its time and days, and Run now. The rest is on the computer. */
export function KinCheckInFormScreen({ route }: StaticScreenProps<KinCheckInFormParams>) {
  const target = targetOf(route.params);
  if (target === null || route.params.checkIn === undefined)
    return (
      <FormMessage title={KIN_CHECK_INS.title}>
        {target === null ? NO_LINK : KIN_SET_UP_ON_COMPUTER.checkInAdd}
      </FormMessage>
    );
  return <CheckInFormRead {...target} scheduleId={route.params.checkIn} />;
}

function CheckInFormRead(props: Target & { readonly scheduleId: string }) {
  const { value, refresh } = useCheckIns(props);
  if (value === null)
    return (
      <FormMessage title={KIN_CHECK_INS.title}>
        <KinWorkLoading label="Loading check-ins" />
      </FormMessage>
    );
  const checkIn = value.checkIns.find((one) => one.scheduleId === props.scheduleId) ?? null;
  if (checkIn === null) return <FormMessage title={KIN_CHECK_INS.title}>{NO_LINK}</FormMessage>;
  return <CheckInForm {...props} checkIn={checkIn} result={value} refresh={refresh} />;
}

function CheckInForm(
  props: Target & {
    readonly checkIn: KinCheckIn;
    readonly result: KinCheckInsResult;
    readonly refresh: () => void;
  },
) {
  const navigation = useNavigation();
  const { checkIn, result } = props;
  const fields = kinBriefSheetFields({ checkIn });
  const save = useAtomCommand(kinClient.checkInSave, { reportFailure: false });
  const act = useAtomCommand(kinClient.checkInAct, { reportFailure: false });
  const [draft, setDraft] = useState({ at: checkIn.at, days: checkIn.days });
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const invalid = kinBriefProblem(draft);
  const environmentId = props.environmentId;

  const finish = async (
    outcome: Promise<AsyncResult.AsyncResult<unknown, unknown>>,
    close: boolean,
  ) => {
    setSaving(true);
    setProblem(null);
    const done = await outcome;
    setSaving(false);
    props.refresh();
    if (AsyncResult.isFailure(done))
      setProblem(kinFailureText(squashAtomCommandFailure(done), KIN_CHECK_INS.failed));
    else if (close) navigation.goBack();
  };
  const tap = (action: KinCheckInActInput["action"]) =>
    void finish(
      act({ environmentId, input: { orgId: props.orgId, scheduleId: checkIn.scheduleId, action } }),
      false,
    );
  const send = () => {
    if (saving || invalid !== null) return;
    void finish(
      save({
        environmentId,
        input: {
          orgId: props.orgId,
          scheduleId: checkIn.scheduleId,
          agentId: checkIn.agentId,
          title: checkIn.title,
          what: checkIn.what,
          at: draft.at,
          days: draft.days,
        },
      }),
      true,
    );
  };

  return (
    <FormShell
      title={checkIn.title}
      submit={KIN_CHECK_INS.save}
      saving={saving}
      canSave={invalid === null}
      problem={problem === null ? null : { kind: "failed", text: problem }}
      onSave={send}
    >
      <ListSection
        footer={[KIN_CHECK_INS.zone(result.zone), kinCoveredLine(checkIn)]
          .filter((line) => line !== null)
          .join(" ")}
      >
        {fields.includes("on") ? (
          <KinWorkToggleRow
            label={KIN_BRIEFS.on}
            value={checkIn.on}
            disabled={saving}
            onValueChange={(on) => tap(on ? "turn_on" : "turn_off")}
          />
        ) : null}
        <KinClockRow
          label={KIN_CHECK_INS.time}
          at={draft.at}
          disabled={saving}
          onPick={(at) => setDraft({ ...draft, at })}
        />
      </ListSection>
      <ListSection title={KIN_CHECK_INS.days}>
        {KIN_WEEKDAYS.map(({ day, short }) => (
          <ListChoiceRow
            key={day}
            label={short}
            selected={draft.days.includes(day)}
            disabled={saving}
            onPress={() =>
              setDraft({
                ...draft,
                days: draft.days.includes(day)
                  ? draft.days.filter((each) => each !== day)
                  : [...draft.days, day],
              })
            }
          />
        ))}
      </ListSection>
      {fields.includes("pipeline") ? (
        <ListSection footer={KIN_CHECK_INS.pipelineDetail}>
          <KinWorkToggleRow
            label={KIN_CHECK_INS.pipeline}
            value={kinCheckInPipeline(checkIn) === true}
            disabled={saving}
            onValueChange={(on) => tap(on ? "numbers_on" : "numbers_off")}
          />
        </ListSection>
      ) : null}
      <ListSection footer={`${KIN_CHECK_INS.agent}: ${checkIn.agentName}`}>
        <ListActionRow
          icon="play"
          label={checkIn.runNowPending ? KIN_CHECK_INS.runNowPending : KIN_CHECK_INS.runNow}
          disabled={saving || checkIn.runNowPending}
          onPress={() => tap("run_now")}
        />
      </ListSection>
    </FormShell>
  );
}
