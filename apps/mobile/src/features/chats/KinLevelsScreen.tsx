import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  EnvironmentId,
  KinAgentId,
  KinChatError,
  KinOrgId,
  type KinLevelsGetInput,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { Alert, View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { appAtomRegistry } from "../../state/atom-registry";
import { useAtomCommand } from "../../state/use-atom-command";
import { kinClient } from "./state/kinClient";
import { kinChatTitle, kinDirectory } from "./state/kinScreenState";
import { useKinHostAt } from "./state/useKinHost";
import {
  kinLevelsFailure,
  kinLevelsFailureText,
  kinLevelsScreenView,
  type KinLevelChange,
  type KinLevelsRow,
} from "./widgets/kinLevelsPresentation";

type KinLevelsParams = {
  readonly environmentId: string;
  readonly orgId: string;
  readonly agentId: string;
};

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeOrgId = Schema.decodeUnknownOption(KinOrgId);
const decodeAgentId = Schema.decodeUnknownOption(KinAgentId);
const isKinChatError = Schema.is(KinChatError);

/** The owner's view of one lead's levels: its own, each chat's cap, the trial and open raises. */
export function KinLevelsScreen({ route }: StaticScreenProps<KinLevelsParams>) {
  const navigation = useNavigation();
  const environmentId = Option.getOrNull(decodeEnvironmentId(route.params.environmentId));
  const orgId = Option.getOrNull(decodeOrgId(route.params.orgId));
  const agentId = Option.getOrNull(decodeAgentId(route.params.agentId));
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar title="Levels" onBack={() => navigation.goBack()} />
      <ScreenContent surface="screen">
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ padding: 16, gap: 16 }}
        >
          {environmentId === null || orgId === null || agentId === null ? (
            <EmptyState
              variant="plain"
              title="This link doesn't name a lead."
              detail="Open Levels from your lead's chat."
            />
          ) : (
            <KinLevelsBody environmentId={environmentId} input={{ orgId, agentId }} />
          )}
        </ScreenScrollView>
      </ScreenContent>
    </View>
  );
}

function KinLevelsBody(props: {
  readonly environmentId: EnvironmentId;
  readonly input: KinLevelsGetInput;
}) {
  const { environmentId, input } = props;
  const atom = kinClient.levels({ environmentId, input });
  const result = useAtomValue(atom);
  const host = useKinHostAt(environmentId);
  const { agentNames } = kinDirectory(host._tag === "unpaired" ? { _tag: "none" } : host);
  const inbox = useAtomValue(kinClient.inbox({ environmentId, input: {} }));
  const canChange = useAtomValue(kinClient.lower.permissionAtom(environmentId));
  const lower = useAtomCommand(kinClient.lower, { reportFailure: false });
  const raise = useAtomCommand(kinClient.raise, { reportFailure: false });
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ readonly text: string; readonly error: boolean } | null>(
    null,
  );

  if (AsyncResult.isInitial(result)) {
    return (
      <View className="items-center py-12" accessible accessibilityLabel="Loading levels">
        <AppActivityIndicator />
      </View>
    );
  }
  if (AsyncResult.isFailure(result)) {
    const cause = Cause.squash(result.cause);
    if (isKinChatError(cause) && (cause.reason === "not_allowed" || cause.reason === "not_found")) {
      return (
        <EmptyState
          variant="plain"
          title="Only the lead's owner can see its levels."
          detail="Ask whoever set up this lead."
        />
      );
    }
    return (
      <View className="gap-3">
        <ErrorBanner message={kinLevelsFailureText(cause)} />
        <View className="self-start">
          <Button
            tone="secondary"
            size="compact"
            label="Retry"
            onPress={() => appAtomRegistry.refresh(atom)}
          />
        </View>
      </View>
    );
  }

  const chats = inbox?._tag === "Success" ? inbox.value.value.chats : [];
  const view = kinLevelsScreenView(result.value, (chatId) => {
    const chat = chats.find((candidate) => candidate.chatId === chatId);
    return chat === undefined ? "A chat" : kinChatTitle(chat, agentNames);
  });
  const name = agentNames.get(input.agentId) ?? "This lead";

  const apply = async (change: KinLevelChange) => {
    if (pending !== null) return;
    setPending(change.key);
    setNotice(null);
    const target = {
      ...input,
      level: change.level,
      ...(change.chatId === null ? {} : { chatId: change.chatId }),
    };
    const outcome =
      change.kind === "lower"
        ? await lower({ environmentId, input: target })
        : await raise({ environmentId, input: target });
    setPending(null);
    const failure = kinLevelsFailure(outcome);
    if (failure !== null) {
      setNotice({ text: kinLevelsFailureText(failure), error: true });
      return;
    }
    setNotice({
      text:
        change.kind === "lower"
          ? `Lowered to ${change.level}.`
          : `Raise to ${change.level} requested. It applies once you sign the approval.`,
      error: false,
    });
    appAtomRegistry.refresh(atom);
  };

  const press = (change: KinLevelChange, row: KinLevelsRow) => {
    if (change.kind === "raise") return void apply(change);
    // Lowering applies at once, and getting back up takes a signed raise.
    Alert.alert(
      `Lower ${row.key === "lead" ? name : row.title} to ${change.level}?`,
      "This applies now. Raising it again needs your signed approval.",
      [
        { text: "Cancel", style: "cancel" },
        { text: change.label, style: "destructive", onPress: () => void apply(change) },
      ],
    );
  };

  const renderRow = (row: KinLevelsRow, title: string) => (
    <View key={row.key} className="gap-2 rounded-[20px] border border-border bg-card-alt p-4">
      <View accessible className="flex-row items-baseline justify-between gap-3">
        <Text textRole="headline" className="min-w-0 shrink font-t3-bold text-foreground">
          {title}
        </Text>
        <Text textRole="headline" className="font-t3-bold text-foreground">
          {row.level}
        </Text>
      </View>
      <Text textRole="caption" className="text-foreground-muted">
        {row.since}
      </Text>
      {canChange && row.changes.length > 0 ? (
        <View className="flex-row flex-wrap gap-2 pt-1">
          {row.changes.map((change) => (
            <Button
              key={change.key}
              size="compact"
              tone={change.kind === "raise" ? "primary" : "secondary"}
              label={change.label}
              accessibilityHint={change.blocked ?? undefined}
              loading={pending === change.key}
              disabled={change.blocked !== null || (pending !== null && pending !== change.key)}
              onPress={() => press(change, row)}
            />
          ))}
        </View>
      ) : null}
      {row.changes
        .filter((change) => change.blocked !== null)
        .map((change) => (
          <Text key={change.key} textRole="caption" className="text-foreground-muted">
            {`${change.label}: ${change.blocked}`}
          </Text>
        ))}
    </View>
  );

  return (
    <>
      {notice === null ? null : (
        <Text
          accessibilityRole={notice.error ? "alert" : undefined}
          accessibilityLiveRegion="polite"
          textRole="footnote"
          className={
            notice.error
              ? "font-t3-medium text-danger-foreground"
              : "font-t3-medium text-foreground-secondary"
          }
        >
          {notice.text}
        </Text>
      )}
      {renderRow(view.lead, name)}
      <View className="gap-1 px-1">
        <Text textRole="footnote" className="font-t3-medium text-foreground-secondary">
          Trial
        </Text>
        {view.trial.map((line) => (
          <Text key={line} textRole="footnote" className="text-foreground-muted">
            {line}
          </Text>
        ))}
      </View>
      {view.pending.length === 0 ? null : (
        <View className="gap-1 px-1">
          <Text textRole="footnote" className="font-t3-medium text-foreground-secondary">
            Waiting raises
          </Text>
          {view.pending.map((item) => (
            <Text key={item.key} textRole="footnote" className="text-foreground-muted">
              {item.text}
            </Text>
          ))}
        </View>
      )}
      {view.chats.length === 0 ? null : (
        <View className="gap-3">
          <Text textRole="footnote" className="px-1 font-t3-medium text-foreground-secondary">
            Chats
          </Text>
          {view.chats.map((row) => renderRow(row, row.title))}
        </View>
      )}
      {canChange ? null : (
        <Text textRole="footnote" className="px-1 text-foreground-muted">
          This device can't change levels. Pair it again from the Mac.
        </Text>
      )}
    </>
  );
}
