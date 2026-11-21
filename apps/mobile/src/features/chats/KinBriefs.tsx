import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  KIN_BRIEFS,
  KIN_CHECK_INS,
  KIN_WEEKDAYS,
  kinBriefLine,
  kinBriefSheetFields,
  kinBriefTitle,
  kinCoveredLine,
  kinBriefProblem,
  kinBriefSave,
  kinWeeklyBrief,
} from "@t3tools/client-runtime/kin/kinCheckIns";
import { kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, KinBrief, KinCheckInsResult, KinOrgId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListSection } from "../../components/ui/ListSection";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsRow } from "../settings/components/SettingsRow";
import { SettingsSection } from "../settings/components/SettingsSection";
import { KinWorkLoading } from "./components/KinWorkPieces";
import { KinCheckInRows, KinClockRow, useCheckIns } from "./KinCheckIns";
import { FormMessage, FormShell, NO_LINK, targetOf } from "./KinWorkFormScreens";
import { kinClient, refreshKinBriefs } from "./state/kinClient";

interface Target {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
}

function useBriefs(target: Target) {
  const atom = kinClient.briefs({
    environmentId: target.environmentId,
    input: { orgId: target.orgId },
  });
  const result = useAtomValue(atom);
  return {
    result,
    value: Option.getOrNull(AsyncResult.value(result)),
    refresh: () => refreshKinBriefs(target.environmentId, target.orgId),
  };
}

/**
 * The briefs this person receives, each opening its sheet; for the owner level the weekly brief
 * follows. An agent's other check-ins are on its page. None for who has neither.
 */
export function KinBriefsSection(props: Target & { readonly checkIns: boolean }) {
  return props.checkIns ? <BriefsWithCheckIns {...props} /> : <Briefs {...props} checkIns={null} />;
}

function BriefsWithCheckIns(props: Target) {
  const { result, value, canRead } = useCheckIns(props);
  return (
    <Briefs
      {...props}
      checkIns={
        !canRead || (AsyncResult.isFailure(result) && value === null) ? null : (value ?? undefined)
      }
    />
  );
}

/** `checkIns` is null where none are shown, undefined while they load. */
function Briefs(props: Target & { readonly checkIns: KinCheckInsResult | null | undefined }) {
  const navigation = useNavigation();
  const { result, value } = useBriefs(props);
  const briefs = value?.briefs ?? [];
  const checkIns = props.checkIns ?? null;
  const weekly = checkIns === null ? null : kinWeeklyBrief(checkIns.checkIns);
  const loading =
    (value === null && !AsyncResult.isFailure(result)) || props.checkIns === undefined;
  if (!loading && briefs.length === 0 && weekly === null) return null;
  const zone = value?.zone ?? checkIns?.zone ?? null;
  const detail =
    briefs.length === 0 && checkIns !== null ? KIN_CHECK_INS.detail : KIN_BRIEFS.detail;
  return (
    <SettingsSection
      title={KIN_BRIEFS.title}
      footer={zone === null ? detail : `${detail} ${KIN_CHECK_INS.zone(zone)}`}
    >
      {loading ? (
        <SettingsRow
          labelWholeWords
          icon="clock"
          label={KIN_BRIEFS.title}
          value="…"
          valuePosition="trailing"
        />
      ) : (
        <>
          {briefs.map((brief) => (
            <SettingsRow
              labelWholeWords
              key={brief.kind}
              icon={brief.on ? "clock" : "moon"}
              label={kinBriefTitle(brief)}
              valuePosition="below"
              value={[kinBriefLine(brief), kinCoveredLine(brief)]
                .filter((line) => line !== null)
                .join("\n")}
              onPress={() =>
                navigation.navigate("KinBriefForm", {
                  environmentId: props.environmentId,
                  orgId: props.orgId,
                  kind: brief.kind,
                })
              }
            />
          ))}
          {weekly === null ? null : <KinCheckInRows {...props} beyond={[weekly]} />}
        </>
      )}
    </SettingsSection>
  );
}

export type KinBriefFormParams = {
  readonly environmentId: string;
  readonly orgId: string;
  readonly kind: string;
};

/** One brief's time, its days for the morning one, and on or off for the others and a page. */
export function KinBriefFormScreen({ route }: StaticScreenProps<KinBriefFormParams>) {
  const target = targetOf(route.params);
  if (target === null) return <FormMessage title={KIN_BRIEFS.title}>{NO_LINK}</FormMessage>;
  return <BriefFormRead {...target} kind={route.params.kind} />;
}

function BriefFormRead(props: Target & { readonly kind: string }) {
  const { value, refresh } = useBriefs(props);
  if (value === null)
    return (
      <FormMessage title={KIN_BRIEFS.title}>
        <KinWorkLoading label={KIN_BRIEFS.loading} />
      </FormMessage>
    );
  const brief = value.briefs.find((one) => one.kind === props.kind);
  if (brief === undefined) return <FormMessage title={KIN_BRIEFS.title}>{NO_LINK}</FormMessage>;
  return <BriefForm {...props} brief={brief} zone={value.zone} refresh={refresh} />;
}

function BriefForm(
  props: Target & {
    readonly brief: KinBrief;
    readonly zone: string;
    readonly refresh: () => void;
  },
) {
  const navigation = useNavigation();
  const save = useAtomCommand(kinClient.briefSave, { reportFailure: false });
  // As the form opened: a refresh while it is open must not count as the person's change.
  const [opened] = useState(props.brief);
  const [draft, setDraft] = useState(props.brief);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const invalid = kinBriefProblem(draft);
  const fields = kinBriefSheetFields({ brief: draft });
  const send = async () => {
    if (saving || invalid !== null) return;
    setSaving(true);
    setProblem(null);
    const done = await save({
      environmentId: props.environmentId,
      input: { orgId: props.orgId, ...kinBriefSave(opened, draft) },
    });
    setSaving(false);
    props.refresh();
    if (AsyncResult.isFailure(done))
      setProblem(kinFailureText(squashAtomCommandFailure(done), KIN_BRIEFS.failed));
    else navigation.goBack();
  };
  return (
    <FormShell
      title={kinBriefTitle(draft)}
      submit={KIN_BRIEFS.save}
      saving={saving}
      canSave={invalid === null}
      problem={problem === null ? null : { kind: "failed", text: problem }}
      onSave={() => void send()}
    >
      <ListSection
        footer={[KIN_CHECK_INS.zone(props.zone), kinCoveredLine(draft)]
          .filter((line) => line !== null)
          .join(" ")}
      >
        {fields.includes("on") ? (
          <ListToggleRow
            label={KIN_BRIEFS.on}
            value={draft.on}
            disabled={saving}
            onValueChange={(on) => setDraft({ ...draft, on })}
          />
        ) : null}
        <KinClockRow
          label={KIN_BRIEFS.time}
          at={draft.at}
          disabled={saving}
          onPick={(at) => setDraft({ ...draft, at })}
        />
      </ListSection>
      {fields.includes("days") ? (
        <ListSection title={KIN_BRIEFS.days}>
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
      ) : null}
    </FormShell>
  );
}
