import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  KIN_CLIENTS,
  KIN_TOUCH_KINDS,
  kinLocalDay,
  kinTouchAt,
  kinTouchNext,
} from "@t3tools/client-runtime/kin/kinWorkClients";
import {
  KIN_WORK_NEW_COPY,
  kinWorkDueChoices,
  kinWorkDueLabel,
} from "@t3tools/client-runtime/kin/kinWork";
import { EnvironmentId, KinOrgId, KinRecordKey, type KinTouchKind } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Chip } from "../../components/ui/Chip";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListSection } from "../../components/ui/ListSection";
import { Notice } from "../../components/ui/Notice";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { useAtomCommand } from "../../state/use-atom-command";
import { KinWorkFrame, KinWorkTextField, useKinAskBeforeDiscard } from "./components/KinWorkPieces";
import { kinClient } from "./state/kinClient";

export type KinTouchFormParams = {
  readonly environmentId: string;
  readonly orgId: string;
  readonly party: string;
};

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeOrgId = Schema.decodeUnknownOption(KinOrgId);
const decodeKey = Schema.decodeUnknownOption(KinRecordKey);
const DAY_MS = 24 * 60 * 60 * 1000;

/** Log a call, meeting or email with a client by hand, today or a day before. */
export function KinTouchFormScreen({ route }: StaticScreenProps<KinTouchFormParams>) {
  const navigation = useNavigation();
  const environmentId = Option.getOrNull(decodeEnvironmentId(route.params.environmentId));
  const orgId = Option.getOrNull(decodeOrgId(route.params.orgId));
  const party = Option.getOrNull(decodeKey(route.params.party));
  const log = useAtomCommand(kinClient.workTouchLog, { reportFailure: false });
  const [requestId] = useState(uuidv4);
  const [kind, setKind] = useState<KinTouchKind>("call");
  const [daysAgo, setDaysAgo] = useState(0);
  const [note, setNote] = useState("");
  const [nextTitle, setNextTitle] = useState("");
  const [nextDay, setNextDay] = useState("");
  const [opened] = useState(() => new Date());
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const leave = useKinAskBeforeDiscard(
    [note, nextTitle, nextDay].some((typed) => typed.trim() !== ""),
  );
  if (environmentId === null || orgId === null || party === null)
    return (
      <KinWorkFrame form title={KIN_CLIENTS.logContact} onClose={() => navigation.goBack()}>
        <EmptyState
          variant="plain"
          title="This link doesn't open anything"
          detail="Open the client and log contact from there."
        />
      </KinWorkFrame>
    );
  const save = async () => {
    if (saving || note.trim() === "") return;
    const next = kinTouchNext(nextTitle, nextDay);
    if (next !== undefined && "problem" in next) return setFailed(next.problem);
    setSaving(true);
    setFailed(null);
    const now = new Date();
    const at = kinTouchAt(kinLocalDay(new Date(now.getTime() - daysAgo * DAY_MS)), now);
    const result = await log({
      environmentId,
      input: {
        orgId,
        party,
        kind,
        note: note.trim(),
        ...(at === undefined ? {} : { at }),
        ...(next === undefined ? {} : { next }),
        clientRequestId: requestId,
      },
    });
    setSaving(false);
    if (result._tag !== "Success")
      return setFailed(kinFailureText(squashAtomCommandFailure(result), KIN_CLIENTS.touchFailed));
    appAtomRegistry.refresh(kinClient.workClient({ environmentId, input: { orgId, key: party } }));
    leave();
    navigation.goBack();
  };
  return (
    <KinWorkFrame
      form
      title={KIN_CLIENTS.logContact}
      onClose={() => navigation.goBack()}
      confirm={{
        label: KIN_CLIENTS.touchSave,
        onPress: () => void save(),
        loading: saving,
        disabled: saving || note.trim() === "",
      }}
    >
      {failed ? <Notice message={failed} onDismiss={() => setFailed(null)} /> : null}
      <View className="gap-2">
        <Text className="px-2 text-sm text-foreground-muted">{KIN_CLIENTS.touchKind}</Text>
        <View className="flex-row flex-wrap gap-2">
          {KIN_TOUCH_KINDS.map((option) => (
            <Chip
              key={option.id}
              label={option.label}
              selected={kind === option.id}
              disabled={saving}
              onPress={() => setKind(option.id)}
            />
          ))}
        </View>
      </View>
      <ListSection>
        <KinWorkTextField
          label={KIN_CLIENTS.touchNote}
          value={note}
          multiline
          autoFocus
          disabled={saving}
          maxLength={4_000}
          onChangeText={setNote}
        />
      </ListSection>
      <View className="gap-2">
        <Text className="px-2 text-sm text-foreground-muted">{KIN_CLIENTS.touchWhen}</Text>
        <View className="flex-row flex-wrap gap-2">
          {["Today", "Yesterday", "2 days ago"].map((label, index) => (
            <Chip
              key={label}
              label={label}
              selected={daysAgo === index}
              disabled={saving}
              onPress={() => setDaysAgo(index)}
            />
          ))}
        </View>
      </View>
      <ListSection>
        <KinWorkTextField
          label={KIN_CLIENTS.nextStepTitle}
          value={nextTitle}
          disabled={saving}
          maxLength={280}
          placeholder={KIN_CLIENTS.nextStepPlaceholder}
          onChangeText={setNextTitle}
        />
      </ListSection>
      {nextTitle.trim() === "" ? null : (
        <View className="gap-2">
          <Text className="px-2 text-sm text-foreground-muted">{KIN_CLIENTS.nextStepWhen}</Text>
          <View className="flex-row flex-wrap gap-2">
            <Chip
              label={KIN_WORK_NEW_COPY.noDue}
              selected={nextDay === ""}
              disabled={saving}
              onPress={() => setNextDay("")}
            />
            {kinWorkDueChoices(opened).map((choice) => (
              <Chip
                key={choice.day}
                label={choice.label}
                accessibilityLabel={`${choice.label}, ${kinWorkDueLabel(choice.day, opened)}`}
                selected={nextDay === choice.day}
                disabled={saving}
                onPress={() => setNextDay(choice.day)}
              />
            ))}
          </View>
        </View>
      )}
    </KinWorkFrame>
  );
}
