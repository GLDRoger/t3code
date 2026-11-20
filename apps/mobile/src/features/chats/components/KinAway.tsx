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
import { useState } from "react";
import { View } from "react-native";

import { AppActivityIndicator } from "../../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import * as Dialog from "../../../components/ui/Dialog";
import { ErrorBanner } from "../../../components/ui/ErrorBanner";
import { ListActionRow } from "../../../components/ui/ListActionRow";
import { ListChoiceRow } from "../../../components/ui/ListChoiceRow";
import { ListSection } from "../../../components/ui/ListSection";
import { Notice } from "../../../components/ui/Notice";
import { Sheet } from "../../../components/ui/Sheet";
import { useAtomCommand } from "../../../state/use-atom-command";
import { kinClient } from "../state/kinClient";
import { useKinWorkDirectory } from "../state/useKinWork";
import { KinWorkTextField } from "./KinWorkPieces";

/**
 * Away until a day, beside working hours: who is away reads it, whoever may edit the profile sets
 * it or says they're back.
 */
export function KinAwaySection(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly profile: KinPersonProfile;
  readonly mine: boolean;
  readonly mayEdit: boolean;
}) {
  const { profile } = props;
  const update = useAtomCommand(kinClient.profileUpdate, { reportFailure: false });
  const [picking, setPicking] = useState(false);
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
    <>
      <ListSection title={KIN_AWAY.label} {...(problem === null ? {} : { footer: problem })}>
        {line === null ? null : (
          <View className="px-4 py-3">
            <Text textRole="body" className="text-foreground">
              {line}
            </Text>
          </View>
        )}
        {props.mayEdit ? (
          <View className={line === null ? undefined : "border-t border-border-subtle"}>
            <ListActionRow
              icon="calendar.badge.clock"
              label={line === null ? KIN_AWAY.set : KIN_AWAY.change}
              disabled={busy}
              onPress={() => setPicking(true)}
            />
          </View>
        ) : null}
        {props.mayEdit && line !== null ? (
          <View className="border-t border-border-subtle">
            <ListActionRow
              icon="arrow.uturn.backward"
              label={KIN_AWAY.back}
              loading={busy}
              disabled={busy}
              onPress={() => void save(null)}
            />
          </View>
        ) : null}
      </ListSection>
      {picking ? (
        <KinAwaySheet
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
    </>
  );
}

function KinAwaySheet(props: {
  readonly profile: KinPersonProfile;
  readonly mine: boolean;
  readonly busy: boolean;
  readonly problem: string | null;
  readonly onSave: (day: string) => Promise<void>;
  readonly onClose: () => void;
}) {
  const { profile } = props;
  const [day, setDay] = useState(
    () => profile.awayUntil ?? kinAwayDefault(new Date(), profile.timeZone),
  );
  const [problem, setProblem] = useState<string | null>(null);
  const shown = problem ?? props.problem;
  const submit = () => {
    const wrong = kinAwayProblem(day, new Date(), profile.timeZone);
    setProblem(wrong);
    if (wrong === null) void props.onSave(day);
  };
  return (
    <Sheet title={KIN_AWAY.title} onClose={props.onClose} dismissDisabled={props.busy}>
      <View className="gap-4 px-4 pt-2 pb-10">
        <Text textRole="footnote" className="text-foreground-muted">
          {props.mine ? KIN_AWAY.mineHint : KIN_AWAY.theirHint(profile.displayName)}
        </Text>
        <ListSection>
          <KinWorkTextField
            label={KIN_AWAY.dayLabel}
            value={day}
            keyboard="numbers"
            maxLength={10}
            placeholder="YYYY-MM-DD"
            disabled={props.busy}
            onChangeText={(text) => setDay(text.trim())}
          />
        </ListSection>
        {shown === null ? null : <ErrorBanner message={shown} />}
        <Button
          label={props.busy ? KIN_AWAY.saving : KIN_AWAY.save}
          loading={props.busy}
          disabled={props.busy}
          fullWidth
          onPress={submit}
        />
      </View>
    </Sheet>
  );
}

type Counted = { readonly keys: ReadonlyArray<KinRecordKey> } | { readonly problem: string } | null;

/**
 * "Give all open tasks to…": counts what `from` holds, asks once whom to, moves them all, and
 * offers Undo, which gives exactly those back.
 */
export function KinHandOverRow(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly from: KinWorkPrincipal;
  /** Null for the viewer's own tasks. */
  readonly fromName: string | null;
  readonly separated?: boolean;
  readonly onDone?: (moved: number) => void;
}) {
  const { environmentId, orgId, from } = props;
  const handOver = useAtomCommand(kinClient.workHandOver, { reportFailure: false });
  const [open, setOpen] = useState(false);
  const [counted, setCounted] = useState<Counted>(null);
  const [given, setGiven] = useState<{
    readonly text: string;
    readonly to: KinWorkPrincipal;
    readonly keys: ReadonlyArray<KinRecordKey>;
  } | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const ask = () => {
    setCounted(null);
    setOpen(true);
    void handOver({ environmentId, input: { orgId, from, to: from, dryRun: true } }).then(
      (outcome) =>
        setCounted(
          AsyncResult.isSuccess(outcome)
            ? { keys: outcome.value.keys }
            : { problem: kinFailureText(squashAtomCommandFailure(outcome), KIN_HAND_OVER.failed) },
        ),
    );
  };
  const undo = async () => {
    if (given === null) return;
    const { to, keys } = given;
    setGiven(null);
    const back = await handOver({ environmentId, input: { orgId, from: to, to: from, keys } });
    setSaid(
      AsyncResult.isSuccess(back)
        ? KIN_HAND_OVER.undone
        : kinFailureText(squashAtomCommandFailure(back), KIN_HAND_OVER.failed),
    );
  };
  return (
    <>
      <View className={props.separated ? "border-t border-border-subtle" : undefined}>
        <ListActionRow
          icon="arrow.right.circle"
          label={props.fromName === null ? KIN_HAND_OVER.mineAction : KIN_HAND_OVER.action}
          onPress={ask}
        />
      </View>
      {given === null ? null : (
        <View className="px-2 pb-2">
          <Notice
            message={given.text}
            action={{ label: KIN_HAND_OVER.undo, onPress: () => void undo() }}
            onDismiss={() => setGiven(null)}
          />
        </View>
      )}
      {said === null ? null : (
        <View className="px-2 pb-2">
          <Notice message={said} onDismiss={() => setSaid(null)} />
        </View>
      )}
      {open ? (
        <KinHandOverSheet
          {...props}
          counted={counted}
          onClose={() => setOpen(false)}
          onGiven={(result) => {
            setSaid(null);
            setGiven(result.keys.length === 0 ? null : result);
            if (result.keys.length === 0) setSaid(result.text);
            props.onDone?.(result.keys.length);
          }}
        />
      ) : null}
    </>
  );
}

function KinHandOverSheet(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly from: KinWorkPrincipal;
  readonly fromName: string | null;
  readonly counted: Counted;
  readonly onGiven: (given: {
    readonly text: string;
    readonly to: KinWorkPrincipal;
    readonly keys: ReadonlyArray<KinRecordKey>;
  }) => void;
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
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const problem =
    failed ?? (props.counted !== null && "problem" in props.counted ? props.counted.problem : null);
  const count = counted?.keys.length ?? 0;
  const give = async (choice: (typeof choices)[number]) => {
    if (counted === null || busy) return;
    setBusy(true);
    setFailed(null);
    const outcome = await handOver({
      environmentId,
      input: { orgId, from, to: choice.principal, keys: counted.keys },
    });
    setBusy(false);
    if (!AsyncResult.isSuccess(outcome))
      return setFailed(kinFailureText(squashAtomCommandFailure(outcome), KIN_HAND_OVER.failed));
    const moved = outcome.value.keys;
    props.onGiven({
      text: `${KIN_HAND_OVER.done(moved.length, choice.name)}${KIN_HAND_OVER.kept(outcome.value.kept)}`,
      to: choice.principal,
      keys: moved,
    });
    props.onClose();
  };
  const title =
    counted === null
      ? props.fromName === null
        ? KIN_HAND_OVER.mineAction
        : KIN_HAND_OVER.action
      : count === 0
        ? KIN_HAND_OVER.none(props.fromName)
        : KIN_HAND_OVER.title(count, props.fromName);
  return (
    <Sheet title={title} onClose={props.onClose} dismissDisabled={busy}>
      <View className="gap-4 px-4 pt-2 pb-10">
        {problem === null ? null : <ErrorBanner message={problem} />}
        {counted === null && problem === null ? (
          <View className="items-center py-6">
            <AppActivityIndicator />
          </View>
        ) : count === 0 ? null : (
          <>
            <Text textRole="footnote" className="text-foreground-muted">
              {KIN_HAND_OVER.hint}
            </Text>
            <ListSection title={KIN_HAND_OVER.pick}>
              {choices.map((choice, index) => (
                <ListChoiceRow
                  key={choice.key}
                  label={choice.name}
                  selected={false}
                  separated={index > 0}
                  disabled={busy}
                  onPress={() =>
                    Dialog.confirm({
                      title: KIN_HAND_OVER.title(count, props.fromName),
                      message: `${KIN_HAND_OVER.pick} ${choice.name}`,
                      confirmText: KIN_HAND_OVER.confirm(count),
                      onConfirm: () => void give(choice),
                    })
                  }
                />
              ))}
            </ListSection>
          </>
        )}
        {busy ? (
          <Text textRole="footnote" className="text-center text-foreground-muted">
            {KIN_HAND_OVER.giving}
          </Text>
        ) : null}
      </View>
    </Sheet>
  );
}
