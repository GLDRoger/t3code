import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import {
  KIN_WATCH_COPY,
  KIN_WATCH_LOG_TITLE,
  kinWatchLine,
  type KinWatchAction,
} from "@t3tools/client-runtime/kin/kinWatches";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { KinRecordKey } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { useNowMinuteMs } from "../../lib/clock";
import { appAtomRegistry } from "../../state/atom-registry";
import { useAtomCommand } from "../../state/use-atom-command";
import { kinClient } from "./state/kinClient";
import type { KinWorkTarget } from "./state/useKinWork";

/**
 * The line on a record Kin watches, in `kinWatchLine`'s words, beside the record's set-aside note:
 * the buttons this person may use, and What Kin checked. A record with no watch shows nothing.
 */
export function KinWatchLine(props: KinWorkTarget & { readonly recordKey: KinRecordKey }) {
  const { environmentId, orgId, recordKey } = props;
  const navigation = useNavigation();
  const watchesAtom = kinClient.watches({ environmentId, input: { orgId, recordKey } });
  const watch = Option.getOrNull(AsyncResult.value(useAtomValue(watchesAtom)))?.watches[0];
  const now = useNowMinuteMs();
  const may: Record<KinWatchAction, boolean> = {
    look: useAtomValue(kinClient.watchLook.permissionAtom(environmentId)),
    stop: useAtomValue(kinClient.watchStop.permissionAtom(environmentId)),
    again: useAtomValue(kinClient.watchAgain.permissionAtom(environmentId)),
  };
  const commands = {
    look: useAtomCommand(kinClient.watchLook, { reportFailure: false }),
    stop: useAtomCommand(kinClient.watchStop, { reportFailure: false }),
    again: useAtomCommand(kinClient.watchAgain, { reportFailure: false }),
  };
  const [busy, setBusy] = useState<KinWatchAction | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const view = watch === undefined ? null : kinWatchLine(watch, now);
  if (watch === undefined || view === null) return null;

  const act = async (action: KinWatchAction) => {
    if (busy !== null) return;
    setBusy(action);
    setProblem(null);
    const result = await commands[action]({
      environmentId,
      input: { orgId, watchId: watch.watchId },
    });
    setBusy(null);
    if (!AsyncResult.isSuccess(result))
      setProblem(kinFailureText(squashAtomCommandFailure(result), KIN_WATCH_COPY.failed[action]));
    appAtomRegistry.refresh(watchesAtom);
  };

  return (
    <ListSection>
      <View className="bg-grouped-card">
        <ListRowLayout icon="eye" label={view.text} />
      </View>
      {view.actions
        .filter((action) => may[action])
        .map((action) => (
          <ListActionRow
            key={action}
            label={KIN_WATCH_COPY[action]}
            loading={busy === action}
            disabled={busy !== null && busy !== action}
            onPress={() => void act(action)}
          />
        ))}
      <ListActionRow
        label={KIN_WATCH_LOG_TITLE}
        onPress={() => navigation.navigate("KinWatchLog", { environmentId, orgId })}
      />
      {problem === null ? null : (
        <Text accessibilityRole="alert" className="px-4 py-2 text-sm text-danger-foreground">
          {problem}
        </Text>
      )}
    </ListSection>
  );
}
