import { kinListRoute } from "./state/kinHome";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, KinChatId, KinOrgId, type KinChatMembersResult } from "@t3tools/contracts";
import { kinFeedViewer } from "@t3tools/client-runtime/kin/kinChatFeed";
import {
  KIN_CLEAR_CHAT_ACTION,
  KIN_CLEAR_CHAT_TITLE,
  kinClearChatBody,
} from "@t3tools/client-runtime/kin/kinClearChat";
import {
  kinGroupCountLabel,
  kinGroupMemberViews,
  kinGroupNameCheck,
  kinGroupProblem,
  type KinGroupMemberView,
} from "@t3tools/client-runtime/kin/kinGroups";
import { kinChatMuted } from "@t3tools/client-runtime/kin/kinScreenState";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListRow } from "../../components/ui/ListRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { appAtomRegistry } from "../../state/atom-registry";
import { useAtomCommand } from "../../state/use-atom-command";
import { KinAvatar } from "./components/KinAvatar";
import { kinClient } from "./state/kinClient";
import { useKinHostAt } from "./state/useKinHost";

export type KinGroupParams = {
  readonly environmentId: string;
  readonly orgId: string;
  readonly chatId: string;
};

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeOrgId = Schema.decodeUnknownOption(KinOrgId);
const decodeChatId = Schema.decodeUnknownOption(KinChatId);

/** Read at render: a mute only ends when its time passes, and a re-render reads it again. */
const mutedNow = (group: KinChatMembersResult, personId: string | null) =>
  personId !== null && kinChatMuted(group, new Set([personId]), Date.now());

/** A group as its members see it: who is in it and which lead answers. Its owner changes both. */
export function KinGroupScreen({ route }: StaticScreenProps<KinGroupParams>) {
  const navigation = useNavigation();
  const environmentId = Option.getOrNull(decodeEnvironmentId(route.params.environmentId));
  const orgId = Option.getOrNull(decodeOrgId(route.params.orgId));
  const chatId = Option.getOrNull(decodeChatId(route.params.chatId));
  if (environmentId === null || orgId === null || chatId === null) {
    return (
      <View collapsable={false} className="flex-1 bg-screen">
        <AppBar title="Group details" onClose={() => navigation.goBack()} />
        <ScreenContent surface="screen">
          <ScreenScrollView
            className="flex-1"
            contentInsetAdjustmentBehavior="automatic"
            contentContainerStyle={{ padding: 16 }}
          >
            <EmptyState
              variant="plain"
              title="This link doesn't name a group"
              detail="Open a group from your chats."
            />
          </ScreenScrollView>
        </ScreenContent>
      </View>
    );
  }
  return <KinGroupBody environmentId={environmentId} orgId={orgId} chatId={chatId} />;
}

function KinGroupBody(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly chatId: KinChatId;
}) {
  const navigation = useNavigation();
  const { environmentId, orgId, chatId } = props;
  const host = useKinHostAt(environmentId);
  const { personId } = kinFeedViewer(
    host._tag === "host" && host.probe._tag === "ready" ? host.probe.orgs : null,
    orgId,
  );
  const atom = kinClient.chatMembers({ environmentId, input: { chatId } });
  const result = useAtomValue(atom);
  // What was last read stays up while a change is read again.
  const group = Option.getOrNull(AsyncResult.value(result));
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar title="Group details" onClose={() => navigation.goBack()} />
      <ScreenContent surface="screen">
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 20 }}
        >
          {group !== null ? (
            <KinGroupDetails
              environmentId={environmentId}
              orgId={orgId}
              group={group}
              personId={personId}
              onChanged={() => appAtomRegistry.refresh(atom)}
            />
          ) : AsyncResult.isInitial(result) ? (
            <View
              className="items-center py-12"
              accessible
              accessibilityRole="progressbar"
              accessibilityLabel="Loading group"
            >
              <AppActivityIndicator />
            </View>
          ) : (
            <EmptyState
              variant="plain"
              title="Couldn't load this group"
              detail="You may no longer be in it, or the server didn't answer."
              action={
                <Button
                  tone="secondary"
                  label="Try again"
                  onPress={() => appAtomRegistry.refresh(atom)}
                />
              }
            />
          )}
        </ScreenScrollView>
      </ScreenContent>
    </View>
  );
}

function KinGroupDetails(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly group: KinChatMembersResult;
  readonly personId: string | null;
  readonly onChanged: () => void;
}) {
  const navigation = useNavigation();
  const { environmentId, orgId, group, personId } = props;
  const { chatId } = group.chat;
  const members = kinGroupMemberViews(group, personId);
  const leads = members.filter((member) => member.kind === "lead");
  const owns = group.members.some(
    (member) =>
      member.leftAt === null &&
      member.role === "owner" &&
      member.principal._tag === "person" &&
      member.principal.personId === personId,
  );
  // The host decides again on every call; this only hides what it would refuse.
  const canChange =
    useAtomValue(kinClient.groupRename.permissionAtom(environmentId)) &&
    owns &&
    group.chat.kind !== "direct";
  const canMute = useAtomValue(kinClient.mute.permissionAtom(environmentId));
  const runMute = useAtomCommand(kinClient.mute, "Muting this chat");
  const rename = useAtomCommand(kinClient.groupRename, { reportFailure: false });
  const setLead = useAtomCommand(kinClient.groupSetLead, { reportFailure: false });
  const removeMember = useAtomCommand(kinClient.groupRemoveMember, { reportFailure: false });
  const deleteGroup = useAtomCommand(kinClient.groupDelete, { reportFailure: false });
  const canClear = useAtomValue(kinClient.clear.permissionAtom(environmentId)) && canChange;
  const clear = useAtomCommand(kinClient.clear, { reportFailure: false });
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const title = group.chat.title ?? "Group";
  const muted = mutedNow(group, personId);

  /** Runs one change, then reads the group again; a refusal shows above the list. */
  const change = async <A, E>(
    key: string,
    doing: string,
    run: () => Promise<AsyncResult.AsyncResult<A, E>>,
  ) => {
    if (busy !== null) return false;
    setBusy(key);
    setProblem(null);
    const result = await run();
    setBusy(null);
    if (AsyncResult.isSuccess(result)) {
      props.onChanged();
      return true;
    }
    setProblem(
      kinGroupProblem(
        AsyncResult.isFailure(result) ? squashAtomCommandFailure(result) : null,
        doing,
      ),
    );
    return false;
  };

  const askRename = () =>
    Dialog.prompt({
      title: "Rename group",
      initialValue: title,
      confirmText: "Save",
      onConfirm: (value) => {
        const checked = kinGroupNameCheck(value);
        if (!checked.ok) {
          setProblem(checked.problem);
          return;
        }
        if (checked.title === title) return;
        void change("rename", "rename this group", () =>
          rename({ environmentId, input: { chatId, title: checked.title } }),
        );
      },
    });

  const askRemove = (member: KinGroupMemberView) =>
    Dialog.confirm({
      title: `Remove ${member.name}?`,
      message:
        member.kind === "lead"
          ? `${member.name} stops answering here. You can add it back any time.`
          : `${member.name} stops seeing this group and its files. You can add them back any time.`,
      confirmText: "Remove",
      destructive: true,
      onConfirm: () =>
        void change(member.memberId, `remove ${member.name}`, () =>
          removeMember({ environmentId, input: { chatId, memberId: member.memberId } }),
        ),
    });

  const askClear = () =>
    Dialog.confirm({
      title: KIN_CLEAR_CHAT_TITLE,
      message: kinClearChatBody("group"),
      confirmText: KIN_CLEAR_CHAT_ACTION,
      destructive: true,
      onConfirm: () =>
        void change("clear", "clear this chat", () =>
          clear({ environmentId, input: { chatId } }),
        ).then((done) => {
          // Nothing to announce: the chat behind this screen is empty.
          if (done) navigation.goBack();
        }),
    });

  const askDelete = () =>
    Dialog.confirm({
      title: `Delete ${title}?`,
      message: "The group closes for everyone in it. This can't be undone.",
      confirmText: "Delete group",
      destructive: true,
      onConfirm: () =>
        void change("delete", "delete this group", () =>
          deleteGroup({ environmentId, input: { chatId } }),
        ).then((done) => {
          // Back past the group's chat, which no longer exists.
          if (done) navigation.navigate(kinListRoute());
        }),
    });

  return (
    <>
      <View className="items-center gap-3 pt-2">
        <KinAvatar avatar={{ kind: "group", seed: `chat:${chatId}` }} size="large" />
        <View className="items-center gap-1">
          <Text textRole="title" className="text-center font-t3-bold text-foreground">
            {title}
          </Text>
          <Text textRole="footnote" className="text-center text-foreground-muted">
            {kinGroupCountLabel(members.length)}
          </Text>
        </View>
      </View>
      {problem === null ? null : <ErrorBanner message={problem} />}
      <ListSection
        title="Members"
        footer={
          leads.length === 0
            ? "No lead is in this group, so messages here get no answer from one."
            : undefined
        }
      >
        {members.map((member, index) => {
          const removable = canChange && member.kind !== "owner";
          const row = (
            <ListRowLayout
              label={member.name}
              description={member.detail ?? undefined}
              leading={<KinAvatar avatar={member.avatar} size="small" />}
              detail={busy === member.memberId ? "Removing…" : undefined}
            />
          );
          return (
            <View
              key={member.memberId}
              className={index === 0 ? undefined : "border-t border-border-subtle"}
            >
              {removable ? (
                <ListRow
                  label={member.name}
                  description={member.detail ?? undefined}
                  leading={<KinAvatar avatar={member.avatar} size="small" />}
                  detail={busy === member.memberId ? "Removing…" : "Remove"}
                  disabled={busy !== null}
                  onPress={() => askRemove(member)}
                />
              ) : (
                row
              )}
            </View>
          );
        })}
        {canChange ? (
          <View className="border-t border-border-subtle">
            <ListActionRow
              label="Add leads or people"
              icon="plus"
              disabled={busy !== null}
              onPress={() => navigation.navigate("KinGroupForm", { environmentId, orgId, chatId })}
            />
          </View>
        ) : null}
      </ListSection>
      {canChange && leads.length > 1 ? (
        <ListSection
          title="Answers when no one is named"
          footer="Name another lead with @ in a message to ask it instead."
        >
          {leads.map((lead, index) => (
            <ListChoiceRow
              key={lead.memberId}
              label={lead.name}
              leading={<KinAvatar avatar={lead.avatar} size="small" />}
              selected={lead.answers}
              separated={index > 0}
              disabled={busy !== null}
              onPress={() => {
                if (lead.answers || lead.principal._tag !== "agent") return;
                const { agentId } = lead.principal;
                void change("lead", "change who answers", () =>
                  setLead({ environmentId, input: { chatId, agentId } }),
                );
              }}
            />
          ))}
        </ListSection>
      ) : null}
      {canMute && personId !== null ? (
        <ListSection title="Notifications">
          <ListToggleRow
            label="Mute notifications"
            value={muted}
            onValueChange={(next) =>
              void runMute({ environmentId, input: { chatId, muted: next } }).then(props.onChanged)
            }
          />
        </ListSection>
      ) : null}
      {canChange ? (
        <ListSection footer="Deleting closes the group for everyone in it.">
          <ListActionRow
            label="Rename group"
            icon="pencil"
            loading={busy === "rename"}
            disabled={busy !== null}
            onPress={askRename}
          />
          {canClear ? (
            <View className="border-t border-border-subtle">
              <ListActionRow
                label={KIN_CLEAR_CHAT_ACTION}
                icon="bubble.left"
                tone="danger"
                loading={busy === "clear"}
                disabled={busy !== null}
                onPress={askClear}
              />
            </View>
          ) : null}
          <View className="border-t border-border-subtle">
            <ListActionRow
              label="Delete group"
              icon="trash"
              tone="danger"
              loading={busy === "delete"}
              disabled={busy !== null}
              onPress={askDelete}
            />
          </View>
        </ListSection>
      ) : null}
    </>
  );
}
