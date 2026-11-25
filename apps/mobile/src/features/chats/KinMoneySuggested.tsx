import {
  KIN_MONEY,
  type KinListOpen,
  type KinMoneySuggestionView,
} from "@t3tools/client-runtime/kin/kinMoney";
import { kinListSend, kinSuggestionKeep } from "@t3tools/client-runtime/kin/kinLists";
import { KIN_WORK_COPY } from "@t3tools/client-runtime/kin/kinWorkChanges";
import type { KinListDefinition, KinRecord, KinRecordKey } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ListSection } from "../../components/ui/ListSection";
import { appAtomRegistry } from "../../state/atom-registry";
import { useAtomCommand } from "../../state/use-atom-command";
import { kinClient } from "./state/kinClient";
import { kinHostConnected } from "./state/useKinHost";
import type { KinWorkTarget } from "./state/useKinWork";
import { kinLines, useKinTextGrows } from "./components/kinTextGrows";

/**
 * Keep or decline money an agent suggested, with the same Keep and Not needed a suggested task
 * has. The host refuses anyone below a co-owner; `allowed` hides the taps where it would.
 */
function useKinKeepSuggestion(target: KinWorkTarget, onChanged: () => void) {
  const { environmentId, orgId } = target;
  const allowed = useAtomValue(kinClient.workConfirm.permissionAtom(environmentId));
  const confirm = useAtomCommand(kinClient.workConfirm, { reportFailure: false });
  const decline = useAtomCommand(kinClient.workDecline, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ key: KinRecordKey; text: string } | null>(null);
  const act = async (row: { readonly key: KinRecordKey; readonly rev: number }, keep: boolean) => {
    setBusy(true);
    setProblem(null);
    const input = { orgId, key: row.key, rev: row.rev };
    const sent = await kinListSend({
      online: () => kinHostConnected(environmentId),
      send: () => (keep ? confirm : decline)({ environmentId, input }),
    });
    setBusy(false);
    if (sent.ok) onChanged();
    else setProblem({ key: row.key, text: sent.problem });
  };
  return { allowed, busy, problem, act };
}

function KeepButtons(props: {
  readonly title: string;
  readonly busy: boolean;
  readonly onKeep: () => void;
  /** Null where Not needed can't drop it. */
  readonly onDecline: (() => void) | null;
}) {
  return (
    <View className="flex-row gap-2">
      <Button
        tone="secondary"
        size="compact"
        label={KIN_WORK_COPY.keep}
        accessibilityLabel={`${KIN_WORK_COPY.keep}: ${props.title}`}
        disabled={props.busy}
        onPress={props.onKeep}
      />
      {props.onDecline === null ? null : (
        <Button
          tone="text"
          size="compact"
          label={KIN_WORK_COPY.decline}
          accessibilityLabel={`${KIN_WORK_COPY.decline}: ${props.title}`}
          disabled={props.busy}
          onPress={props.onDecline}
        />
      )}
    </View>
  );
}

/** Money an agent suggested that no figure counts yet, each kept or declined in one tap. */
export function KinMoneySuggested(
  props: KinWorkTarget & {
    readonly rows: ReadonlyArray<KinMoneySuggestionView>;
    readonly more: ReadonlyArray<{ readonly label: string; readonly open: KinListOpen }>;
    readonly onOpenKey: (key: KinRecordKey) => void;
    readonly onOpenList: (open: KinListOpen) => void;
    readonly onChanged: () => void;
  },
) {
  const grows = useKinTextGrows();
  const { allowed, busy, problem, act } = useKinKeepSuggestion(props, props.onChanged);
  return (
    <ListSection title={KIN_MONEY.suggested} footer={KIN_MONEY.suggestedNote}>
      {props.rows.map((row) => (
        <View key={row.key} className="bg-grouped-card">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={[row.title, row.amount, row.line]
              .filter((part) => part !== null)
              .join(". ")}
            onPress={() => props.onOpenKey(row.key)}
            className="min-h-11 flex-row items-center gap-3 px-4 py-2.5 active:opacity-60"
          >
            <View className="min-w-0 flex-1 gap-0.5">
              <Text textRole="body" numberOfLines={kinLines(1, grows)} className="text-foreground">
                {row.title}
              </Text>
              <Text
                textRole="footnote"
                numberOfLines={kinLines(1, grows)}
                className="text-foreground-muted"
              >
                {row.line}
              </Text>
            </View>
            {row.amount === null ? null : (
              <Text textRole="body" className="tabular-nums text-foreground">
                {row.amount}
              </Text>
            )}
          </Pressable>
          {allowed ? (
            <View className="px-4 pb-3">
              <KeepButtons
                title={row.title}
                busy={busy}
                onKeep={() => void act(row, true)}
                onDecline={() => void act(row, false)}
              />
            </View>
          ) : null}
          {problem?.key === row.key ? (
            <Text
              textRole="footnote"
              accessibilityRole="alert"
              className="px-4 pb-3 text-danger-foreground"
            >
              {problem.text}
            </Text>
          ) : null}
        </View>
      ))}
      {props.more.map((more) => (
        <View key={more.open.list} className="items-start bg-grouped-card px-4 py-2">
          <Button
            tone="text"
            size="compact"
            label={more.label}
            onPress={() => props.onOpenList(more.open)}
          />
        </View>
      ))}
    </ListSection>
  );
}

/** On a suggested entry's own page: that Money doesn't count it, and Keep or Not needed. */
export function KinSuggestionKeep(
  props: KinWorkTarget & {
    readonly item: Pick<KinRecord, "key" | "rev" | "title" | "list" | "amount">;
    readonly def: KinListDefinition | null;
  },
) {
  const { environmentId, orgId, item } = props;
  const { allowed, busy, problem, act } = useKinKeepSuggestion(props, () =>
    appAtomRegistry.refresh(kinClient.workItem({ environmentId, input: { orgId, key: item.key } })),
  );
  if (!allowed) return null;
  const { note, declines } = kinSuggestionKeep(item, props.def);
  return (
    <View className="gap-2">
      {note === null ? null : (
        <Text textRole="footnote" className="text-foreground-muted">
          {note}
        </Text>
      )}
      <KeepButtons
        title={item.title}
        busy={busy}
        onKeep={() => void act(item, true)}
        onDecline={declines ? () => void act(item, false) : null}
      />
      {problem === null ? null : (
        <Text textRole="footnote" accessibilityRole="alert" className="text-danger-foreground">
          {problem.text}
        </Text>
      )}
    </View>
  );
}
