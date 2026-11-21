import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { KIN_DEALS, kinDealStepHint } from "@t3tools/client-runtime/kin/kinDeals";
import { kinParseMoney } from "@t3tools/client-runtime/kin/kinLists";
import {
  KIN_WORK_NEW_COPY,
  kinWorkOnlyOwner,
  type KinWorkRef,
} from "@t3tools/client-runtime/kin/kinWork";
import type { KinPersonId } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Chip } from "../../components/ui/Chip";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { useNowMinuteMs } from "../../lib/clock";
import { uuidv4 } from "../../lib/uuid";
import { KinDayField } from "./components/KinDayField";
import { KinWorkPlacePicker } from "./components/KinWorkPlacePicker";
import { KinGateView, KinWorkTextField } from "./components/KinWorkPieces";
import { FormMessage, FormShell, NO_LINK, targetOf } from "./KinWorkFormScreens";
import { kinWorkRefParam } from "./state/kinWorkParams";
import { useKinIsOwnerLevel } from "./state/kinChatOnly";
import { kinClient } from "./state/kinClient";
import { useKinDealSend, useKinDealStages } from "./state/useKinDeals";
import { useKinGate } from "./state/useKinHost";
import { useKinHomeCurrency } from "./state/useKinMoney";
import { useKinWorkChoices, useKinWorkDirectory, type KinWorkTarget } from "./state/useKinWork";

export type KinDealNewParams = {
  readonly environmentId: string;
  readonly orgId: string;
  /** The client it is for, fixed when it starts from the client's page. */
  readonly party?: string;
  readonly partyName?: string;
};

/** New deal: for whom, what, how much, when, which stage, and its first next step or "None yet". */
export function KinDealNewScreen({ route }: StaticScreenProps<KinDealNewParams>) {
  const target = targetOf(route.params);
  if (target === null) return <FormMessage title={KIN_DEALS.newDeal}>{NO_LINK}</FormMessage>;
  return (
    <KinDealNewGate
      {...target}
      party={kinWorkRefParam(route.params.party, route.params.partyName)}
    />
  );
}

function KinDealNewGate(props: KinWorkTarget & { readonly party: KinWorkRef | null }) {
  const gate = useKinGate(
    kinClient.workDealCreate.permissionStateAtom(props.environmentId),
    props.environmentId,
  );
  if (gate !== null)
    return (
      <FormMessage title={KIN_DEALS.newDeal}>
        <KinGateView gate={gate} refused={kinWorkOnlyOwner("clients")} label={KIN_DEALS.newDeal} />
      </FormMessage>
    );
  return <KinDealNewForm {...props} />;
}

const ME = "me";

function KinDealNewForm(props: KinWorkTarget & { readonly party: KinWorkRef | null }) {
  const navigation = useNavigation();
  const { environmentId, orgId } = props;
  const target = { environmentId, orgId };
  const { names } = useKinWorkDirectory(target, true);
  const choices = useKinWorkChoices(target, props.party === null);
  const ownerLevel = useKinIsOwnerLevel(environmentId);
  const home = useKinHomeCurrency(target) ?? "USD";
  const stagesRead = useKinDealStages(target).state;
  const stages = stagesRead._tag === "ready" ? stagesRead.value.stages : [];
  const send = useKinDealSend(target);
  const now = new Date(useNowMinuteMs());
  // One id for the form's life: trying again after a dropped answer never adds a second deal.
  const [requestId] = useState(uuidv4);
  const [party, setParty] = useState<KinWorkRef | null>(props.party);
  const [title, setTitle] = useState("");
  const [value, setValue] = useState("");
  const [expected, setExpected] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const stage = picked ?? stages[0]?.id ?? null;
  const [owner, setOwner] = useState<string>(ME);
  const [source, setSource] = useState("");
  const [step, setStep] = useState("");
  const [stepDay, setStepDay] = useState<string | null>(null);
  const [noneYet, setNoneYet] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const money = value.trim() === "" ? null : kinParseMoney(value, home);
  const moneyBad = value.trim() !== "" && money === null;
  const stepHint = kinDealStepHint(step, noneYet);
  const canSave = party !== null && title.trim() !== "" && !moneyBad && stepHint === undefined;
  const people = [...names.people.entries()].filter(([id]) => id !== names.me);

  const save = async () => {
    if (!canSave || party === null || saving) return;
    setSaving(true);
    setProblem(null);
    const outcome = await send.create({
      party: party.key,
      title: title.trim(),
      ...(stage === null ? {} : { stage }),
      ...(money === null ? {} : { value: money }),
      ...(expected === null ? {} : { expectedOn: expected }),
      ...(source.trim() === "" ? {} : { source: source.trim() }),
      ...(owner === ME || !ownerLevel
        ? {}
        : { owner: { _tag: "person", personId: owner as KinPersonId } }),
      ...(noneYet || step.trim() === ""
        ? {}
        : {
            next: {
              title: step.trim(),
              ...(stepDay === null ? {} : { dueAt: stepDay, dueAllDay: true }),
            },
          }),
      clientRequestId: requestId,
    });
    setSaving(false);
    if (!outcome.ok) return setProblem(outcome.problem);
    navigation.goBack();
    navigation.navigate("KinDeal", { environmentId, orgId, deal: outcome.value.deal.key });
  };

  return (
    <FormShell
      title={KIN_DEALS.newDeal}
      submit={KIN_DEALS.add}
      saving={saving}
      canSave={canSave}
      problem={problem === null ? null : { kind: "invalid", text: problem }}
      onSave={() => void save()}
    >
      <ListSection>
        {props.party !== null ? (
          <ListRowLayout label={KIN_DEALS.clientField} detail={props.party.title} />
        ) : (
          <KinWorkPlacePicker
            target={target}
            noun="client"
            icon="person.2"
            label={KIN_DEALS.clientField}
            held={party}
            choices={choices.clients}
            clearable={false}
            disabled={saving}
            onPick={setParty}
          />
        )}
        <KinWorkTextField
          label={KIN_DEALS.what}
          value={title}
          autoFocus={props.party !== null}
          maxLength={280}
          disabled={saving}
          onChangeText={setTitle}
        />
        <KinWorkTextField
          label={KIN_DEALS.value}
          value={value}
          keyboard="numbers"
          disabled={saving}
          hint={moneyBad ? KIN_DEALS.notAmount : KIN_DEALS.valueHint}
          onChangeText={setValue}
        />
        <KinDayField
          label={KIN_DEALS.expected}
          day={expected}
          zone={names.zone}
          now={now}
          disabled={saving}
          onPick={setExpected}
        />
      </ListSection>
      {stages.length === 0 ? null : (
        <View className="gap-2">
          <Text className="px-2 text-sm text-foreground-muted">{KIN_DEALS.stage}</Text>
          <View className="flex-row flex-wrap gap-2">
            {stages.map((held) => (
              <Chip
                key={held.id}
                label={held.name}
                selected={held.id === stage}
                disabled={saving}
                onPress={() => setPicked(held.id)}
              />
            ))}
          </View>
        </View>
      )}
      {!ownerLevel || people.length === 0 ? null : (
        <View className="gap-2">
          <Text className="px-2 text-sm text-foreground-muted">{KIN_DEALS.lookedAfterBy}</Text>
          <View className="flex-row flex-wrap gap-2">
            <Chip
              label="You"
              selected={owner === ME}
              disabled={saving}
              onPress={() => setOwner(ME)}
            />
            {people.map(([id, name]) => (
              <Chip
                key={id}
                label={name}
                selected={owner === id}
                disabled={saving}
                onPress={() => setOwner(id)}
              />
            ))}
          </View>
        </View>
      )}
      <ListSection title={KIN_DEALS.nextStep}>
        <KinWorkTextField
          label={KIN_DEALS.nextStep}
          value={step}
          maxLength={280}
          disabled={saving || noneYet}
          hint={stepHint}
          onChangeText={setStep}
        />
        {noneYet ? null : (
          <KinDayField
            label={KIN_WORK_NEW_COPY.dueLabel}
            day={stepDay}
            zone={names.zone}
            now={now}
            disabled={saving}
            onPick={setStepDay}
          />
        )}
        <ListToggleRow
          label={KIN_DEALS.noneYet}
          value={noneYet}
          disabled={saving}
          onValueChange={setNoneYet}
        />
      </ListSection>
      <ListSection>
        <KinWorkTextField
          label={KIN_DEALS.cameFrom}
          value={source}
          maxLength={120}
          disabled={saving}
          onChangeText={setSource}
        />
      </ListSection>
    </FormShell>
  );
}
