import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  KIN_CHECK_INS,
  KIN_WEEKDAYS,
  kinCheckInDraft,
  kinCheckInLine,
  kinCoveredLine,
  kinCheckInProblem,
  type KinCheckInDraft,
} from "@t3tools/client-runtime/kin/kinCheckIns";
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

import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListSection } from "../../components/ui/ListSection";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsRow } from "../settings/components/SettingsRow";
import { KinWorkLoading, KinWorkTextField } from "./components/KinWorkPieces";
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

/** The company's check-ins beyond the person's own briefs, in the Briefs section; each opens its sheet. */
export function KinCheckInRows(
  props: Target & {
    readonly result: KinCheckInsResult;
    readonly beyond: ReadonlyArray<KinCheckIn>;
  },
) {
  const navigation = useNavigation();
  return (
    <>
      {props.beyond.map((checkIn) => (
        <SettingsRow
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
      {props.result.agents.length === 0 ? null : (
        <SettingsRow
          icon="plus"
          label={KIN_CHECK_INS.add}
          onPress={() =>
            navigation.navigate("KinCheckInForm", {
              environmentId: props.environmentId,
              orgId: props.orgId,
            })
          }
        />
      )}
    </>
  );
}

export type KinCheckInFormParams = {
  readonly environmentId: string;
  readonly orgId: string;
  readonly checkIn?: string;
};

/** Add a check-in, or change, run, turn off or remove one, as a sheet over Settings. */
export function KinCheckInFormScreen({ route }: StaticScreenProps<KinCheckInFormParams>) {
  const target = targetOf(route.params);
  const title = route.params.checkIn === undefined ? KIN_CHECK_INS.add : KIN_CHECK_INS.edit;
  if (target === null) return <FormMessage title={title}>{NO_LINK}</FormMessage>;
  return <CheckInFormRead {...target} scheduleId={route.params.checkIn ?? null} title={title} />;
}

function CheckInFormRead(
  props: Target & { readonly scheduleId: string | null; readonly title: string },
) {
  const { value, refresh } = useCheckIns(props);
  if (value === null)
    return (
      <FormMessage title={props.title}>
        <KinWorkLoading label="Loading check-ins" />
      </FormMessage>
    );
  const checkIn =
    props.scheduleId === null
      ? null
      : (value.checkIns.find((one) => one.scheduleId === props.scheduleId) ?? null);
  if (props.scheduleId !== null && checkIn === null)
    return <FormMessage title={props.title}>{NO_LINK}</FormMessage>;
  return <CheckInForm {...props} checkIn={checkIn} result={value} refresh={refresh} />;
}

function CheckInForm(
  props: Target & {
    readonly checkIn: KinCheckIn | null;
    readonly result: KinCheckInsResult;
    readonly title: string;
    readonly refresh: () => void;
  },
) {
  const navigation = useNavigation();
  const { checkIn, result } = props;
  const save = useAtomCommand(kinClient.checkInSave, { reportFailure: false });
  const act = useAtomCommand(kinClient.checkInAct, { reportFailure: false });
  const [draft, setDraft] = useState<KinCheckInDraft>(() =>
    kinCheckInDraft(checkIn, result.agents[0]?.agentId ?? null),
  );
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const edit = (patch: Partial<KinCheckInDraft>) => setDraft({ ...draft, ...patch });
  const invalid = kinCheckInProblem(draft);
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
  const tap = (action: KinCheckInActInput["action"]) => {
    if (checkIn === null) return;
    void finish(
      act({ environmentId, input: { orgId: props.orgId, scheduleId: checkIn.scheduleId, action } }),
      action === "remove",
    );
  };
  const send = () => {
    if (saving || invalid !== null || draft.agentId === null) return;
    void finish(
      save({
        environmentId,
        input: {
          orgId: props.orgId,
          ...(draft.scheduleId === undefined ? {} : { scheduleId: draft.scheduleId }),
          agentId: draft.agentId,
          title: draft.title.trim(),
          what: draft.what.trim(),
          at: draft.at,
          days: draft.days,
        },
      }),
      true,
    );
  };

  return (
    <FormShell
      title={props.title}
      submit={KIN_CHECK_INS.save}
      saving={saving}
      canSave={invalid === null}
      problem={problem === null ? null : { kind: "failed", text: problem }}
      onSave={send}
    >
      <ListSection
        footer={[KIN_CHECK_INS.zone(result.zone), checkIn === null ? null : kinCoveredLine(checkIn)]
          .filter((line) => line !== null)
          .join(" ")}
      >
        <KinWorkTextField
          label={KIN_CHECK_INS.name}
          value={draft.title}
          disabled={saving}
          maxLength={200}
          onChangeText={(title) => edit({ title })}
        />
        <KinWorkTextField
          label={KIN_CHECK_INS.time}
          value={draft.at}
          keyboard="numbers"
          disabled={saving}
          maxLength={5}
          placeholder="09:30"
          hint={invalid === "Set a time such as 09:30." ? invalid : undefined}
          onChangeText={(at) => edit({ at: at.trim() })}
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
              edit({
                days: draft.days.includes(day)
                  ? draft.days.filter((each) => each !== day)
                  : [...draft.days, day],
              })
            }
          />
        ))}
      </ListSection>
      {checkIn === null ? (
        <ListSection title={KIN_CHECK_INS.agent}>
          {result.agents.map((agent) => (
            <ListChoiceRow
              key={agent.agentId}
              label={agent.name}
              selected={draft.agentId === agent.agentId}
              disabled={saving}
              onPress={() => edit({ agentId: agent.agentId })}
            />
          ))}
        </ListSection>
      ) : null}
      <ListSection>
        <KinWorkTextField
          label={KIN_CHECK_INS.what}
          value={draft.what}
          multiline
          disabled={saving}
          maxLength={2000}
          onChangeText={(what) => edit({ what })}
        />
      </ListSection>
      {checkIn === null ? null : (
        <ListSection footer={`${KIN_CHECK_INS.agent}: ${checkIn.agentName}`}>
          <ListActionRow
            icon="play"
            label={checkIn.runNowPending ? KIN_CHECK_INS.runNowPending : KIN_CHECK_INS.runNow}
            disabled={saving || checkIn.runNowPending}
            onPress={() => tap("run_now")}
          />
          <ListActionRow
            icon={checkIn.on ? "pause" : "clock"}
            label={checkIn.on ? KIN_CHECK_INS.turnOff : KIN_CHECK_INS.turnOn}
            disabled={saving}
            onPress={() => tap(checkIn.on ? "turn_off" : "turn_on")}
          />
          <ListActionRow
            icon="trash"
            tone="danger"
            label={KIN_CHECK_INS.remove}
            disabled={saving}
            onPress={() =>
              Dialog.confirm({
                title: KIN_CHECK_INS.removeConfirm,
                confirmText: KIN_CHECK_INS.remove,
                destructive: true,
                onConfirm: () => tap("remove"),
              })
            }
          />
        </ListSection>
      )}
    </FormShell>
  );
}
