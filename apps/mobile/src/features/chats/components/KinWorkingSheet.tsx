import { kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import {
  KIN_WORKING_COPY,
  kinWorkingStoppable,
  type KinWorkingItem,
} from "@t3tools/client-runtime/kin/kinChatWorking";
import { kinAgentAvatar } from "@t3tools/client-runtime/kin/kinScreenState";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { KinOrgId, type EnvironmentId, type KinWakeupId } from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { SymbolView } from "../../../components/ui/AppSymbol";
import * as Dialog from "../../../components/ui/Dialog";
import { IconButton } from "../../../components/ui/IconButton";
import { Sheet } from "../../../components/ui/Sheet";
import { cn } from "../../../lib/cn";
import { useAtomCommand } from "../../../state/use-atom-command";
import { useVisibleSecondClock } from "../../threads/use-visible-second-clock";
import { kinClient } from "../state/kinClient";
import { KinAvatar } from "./KinAvatar";

export interface KinWorkingStop {
  /** The wake-up a stop is in flight for. */
  readonly stopping: string | null;
  /** Why the last stop didn't happen, by item key. */
  readonly failed: { readonly key: string; readonly text: string } | null;
  /**
   * Asks first, as T3's agents sheet does, then interrupts the item's wake-up. A refusal shows
   * under the sheet's row, or as an alert from the pill.
   */
  readonly confirmStop: (item: KinWorkingItem, failure?: "row" | "alert") => void;
}

/** One stop path for the pill and the sheet: `kin.lead.interrupt`, which the host allows or refuses. */
export function useKinWorkingStop(environmentId: EnvironmentId, orgId: string): KinWorkingStop {
  const interrupt = useAtomCommand(kinClient.leadInterrupt, { reportFailure: false });
  const [stopping, setStopping] = useState<string | null>(null);
  const [failed, setFailed] = useState<KinWorkingStop["failed"]>(null);
  const stop = async (item: KinWorkingItem, wakeupId: KinWakeupId, failure: "row" | "alert") => {
    setStopping(wakeupId);
    setFailed(null);
    const result = await interrupt({
      environmentId,
      input: { orgId: KinOrgId.make(orgId), wakeupId },
    });
    setStopping(null);
    const text = !AsyncResult.isSuccess(result)
      ? kinFailureText(squashAtomCommandFailure(result), KIN_WORKING_COPY.stopFailed)
      : result.value.interrupted
        ? null
        : KIN_WORKING_COPY.alreadyDone;
    if (text === null) return;
    if (failure === "alert") Dialog.alert(text);
    else setFailed({ key: item.key, text });
  };
  return {
    stopping,
    failed,
    confirmStop: (item, failure = "row") => {
      const { wakeupId } = item;
      if (wakeupId === null || stopping !== null) return;
      Dialog.confirm({
        title: KIN_WORKING_COPY.stopTitle(item.name),
        message: KIN_WORKING_COPY.stopMessage,
        confirmText: KIN_WORKING_COPY.stop,
        destructive: true,
        onConfirm: () => void stop(item, wakeupId, failure),
      });
    },
  };
}

/** "Working now": each thing working for this chat, its stop where the host has one. */
export function KinWorkingSheet(props: {
  readonly items: ReadonlyArray<KinWorkingItem>;
  readonly canInterrupt: boolean;
  readonly stop: KinWorkingStop;
  readonly onOpen: (item: KinWorkingItem) => void;
  readonly onClose: () => void;
}) {
  const now = useVisibleSecondClock(true);
  return (
    <Sheet title={KIN_WORKING_COPY.title} onClose={props.onClose}>
      <View className="px-5 pb-10">
        {props.items.map((item) => (
          <KinWorkingRow
            key={item.key}
            item={item}
            now={now}
            stoppable={kinWorkingStoppable(item, props.canInterrupt)}
            stop={props.stop}
            onOpen={props.onOpen}
          />
        ))}
      </View>
    </Sheet>
  );
}

function KinWorkingRow(props: {
  readonly item: KinWorkingItem;
  readonly now: number;
  readonly stoppable: boolean;
  readonly stop: KinWorkingStop;
  readonly onOpen: (item: KinWorkingItem) => void;
}) {
  const { item, stop } = props;
  const since = item.since === null ? Number.NaN : Date.parse(item.since);
  const elapsed = Number.isNaN(since) ? null : formatDuration(Math.max(0, props.now - since));
  const stopping = item.wakeupId !== null && stop.stopping === item.wakeupId;
  const failed = stop.failed?.key === item.key ? stop.failed.text : null;
  const row = (
    <View className="flex-row gap-3 py-3.5">
      <KinAvatar avatar={kinAgentAvatar(item.agentId ?? `worker:${item.key}`)} size="small" />
      <View className="min-w-0 flex-1 gap-1">
        <View className="min-h-5 flex-row items-center gap-2">
          <View className="min-w-0 flex-1 flex-row items-baseline gap-1.5">
            <Text numberOfLines={1} className="min-w-0 shrink font-t3-medium text-sm">
              {item.name}
            </Text>
            <Text
              accessibilityElementsHidden
              importantForAccessibility="no"
              className="shrink-0 text-xs text-foreground-muted"
            >
              ·
            </Text>
            <Text
              numberOfLines={1}
              className={cn(
                "shrink text-xs font-t3-medium",
                item.held ? "text-warning-foreground" : "text-foreground-muted",
              )}
            >
              {item.state}
            </Text>
          </View>
          {elapsed === null ? null : (
            <Text className="shrink-0 text-xs tabular-nums text-foreground-muted">{elapsed}</Text>
          )}
          {item.open === null ? null : (
            <SymbolView name="chevron.right" size={12} tintColorClassName="accent-icon-subtle" />
          )}
        </View>
        {item.doing === null ? null : (
          <Text numberOfLines={2} className="text-xs text-foreground-muted">
            {item.doing}
          </Text>
        )}
        {failed === null ? null : (
          <Text accessibilityRole="alert" className="text-xs text-danger-foreground">
            {failed}
          </Text>
        )}
      </View>
    </View>
  );
  return (
    <View className="flex-row items-center border-b border-border">
      {item.open === null ? (
        <View accessible className="min-w-0 flex-1">
          {row}
        </View>
      ) : (
        <Pressable
          accessibilityRole="link"
          onPress={() => props.onOpen(item)}
          className="min-w-0 flex-1 active:opacity-70"
        >
          {row}
        </Pressable>
      )}
      {props.stoppable ? (
        <IconButton
          icon="stop.fill"
          variant="danger"
          accessibilityLabel={stopping ? `Stopping ${item.name}` : `Stop ${item.name}`}
          disabled={stopping || stop.stopping !== null}
          onPress={() => stop.confirmStop(item)}
        />
      ) : null}
    </View>
  );
}
