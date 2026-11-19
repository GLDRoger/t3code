import { KIN_AGENT_PAGE } from "@t3tools/client-runtime/kin/kinAgentPage";
import { KIN_RETRY, KIN_CHECK_CONNECTION } from "@t3tools/client-runtime/kin/kinAnswers";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  EnvironmentId,
  KinOrgId,
  type KinChatId,
  type KinChatSummary,
  type KinLeadAccessResult,
  type KinLeadContact,
  type KinLeadProfile,
  type KinPeopleListResult,
  type KinPersonId,
} from "@t3tools/contracts";
import {
  kinDomainLabel,
  KIN_LEAD_EVERYONE,
  kinLeadAccessCandidates,
  kinLeadAccessChanged,
  kinLeadContactAbout,
  kinLeadOwnerSeesLine,
  kinLeadAccessProblem,
  kinLeadTrackingDetail,
  KIN_AGENTS_COPY,
} from "@t3tools/client-runtime/kin/kinLeadPresentation";
import {
  KIN_RETIRE_ACTION,
  KIN_RETIRE_NEXT_TEAM_AGENT,
  kinAgentGroups,
  kinRestoreCopy,
  kinNextTeamAgentChoices,
  kinRetireOffer,
} from "@t3tools/client-runtime/kin/kinAgentRetire";
import { kinFeedViewer } from "@t3tools/client-runtime/kin/kinChatFeed";
import {
  KIN_CLEAR_CHAT_ACTION,
  KIN_CLEAR_CHAT_DONE,
  KIN_CLEAR_CHAT_TITLE,
  kinClearChatBody,
  kinClearChatKept,
  kinOwnsDirectChat,
} from "@t3tools/client-runtime/kin/kinClearChat";
import { kinAgentAvatar, kinChatMuted } from "@t3tools/client-runtime/kin/kinScreenState";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useState, type ReactNode } from "react";
import { View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { Menu } from "../../components/ui/Menu";
import { ListRow } from "../../components/ui/ListRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { appAtomRegistry } from "../../state/atom-registry";
import { useAtomCommand } from "../../state/use-atom-command";
import { KinAvatar } from "./components/KinAvatar";
import { KinAgentSections } from "./KinAgentSections";
import { kinClient } from "./state/kinClient";
import { useKinWorkingAgents } from "./state/useKinInbox";
import { kinRetiredWhenNow, useKinAgentRetire } from "./state/useKinAgentRetire";
import { useKinHostAt } from "./state/useKinHost";

export type KinLeadParams = {
  readonly environmentId: string;
  readonly orgId: string;
  readonly agentId: string;
};

const kinSentenceParts = (parts: ReadonlyArray<string | null>) =>
  parts.filter((part) => part !== null).join(" · ") || null;

type AccessResult = AsyncResult.AsyncResult<KinLeadAccessResult, unknown>;
type AccessPerson = KinLeadAccessResult["people"][number];
type PeopleResult = AsyncResult.AsyncResult<KinPeopleListResult, unknown>;
// Read only by a session that may change who messages a lead; others ask the host nothing.
const noAccessAtom: Atom.Atom<AccessResult> = Atom.make(AsyncResult.initial());
const noPeopleAtom: Atom.Atom<PeopleResult> = Atom.make(AsyncResult.initial());

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeOrgId = Schema.decodeUnknownOption(KinOrgId);

/**
 * A lead as its owner sees it: who it is, what it is for, who can message it and what it has in
 * hand. A person let message someone else's lead sees its name and what its owner wrote for them.
 */
export function KinLeadScreen({ route }: StaticScreenProps<KinLeadParams>) {
  const navigation = useNavigation();
  const environmentId = Option.getOrNull(decodeEnvironmentId(route.params.environmentId));
  const orgId = Option.getOrNull(decodeOrgId(route.params.orgId));
  if (environmentId === null || orgId === null) {
    return (
      <View collapsable={false} className="flex-1 bg-screen">
        <AppBar title="Agent details" onClose={() => navigation.goBack()} />
        <ScreenContent surface="screen">
          <ScreenScrollView
            className="flex-1"
            contentInsetAdjustmentBehavior="automatic"
            contentContainerStyle={{ padding: 16 }}
          >
            <EmptyState
              variant="plain"
              title="This link doesn't name an agent"
              detail="Open an agent from its chat."
            />
          </ScreenScrollView>
        </ScreenContent>
      </View>
    );
  }
  return <KinLeadBody environmentId={environmentId} orgId={orgId} agentId={route.params.agentId} />;
}

function KinLeadBody(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly agentId: string;
}) {
  const navigation = useNavigation();
  const { environmentId, orgId, agentId } = props;
  // The owner's list keeps their retired agents, so one still has details and a way back.
  const canRestore = useAtomValue(kinClient.leadRestore.permissionAtom(environmentId));
  const canRetire = useAtomValue(kinClient.leadRetire.permissionAtom(environmentId));
  const working = useKinWorkingAgents(environmentId);
  const atom = canRestore
    ? kinClient.agents({ environmentId, orgId })
    : kinClient.leads({ environmentId, input: { orgId } });
  const result = useAtomValue(atom);
  const retire = useKinAgentRetire(environmentId);
  // What was last read stays up while a change is read again.
  const held = Option.getOrNull(AsyncResult.value(result));
  const lead = held?.leads.find((entry) => entry.agentId === agentId) ?? null;
  const isRetired = lead?.retired !== undefined;
  // A retired agent takes no changes; it is restored first.
  const canEdit = useAtomValue(kinClient.leadUpdate.permissionAtom(environmentId)) && !isRetired;
  const retireOffer =
    lead === null || held === null
      ? null
      : kinRetireOffer(lead, kinAgentGroups(held.leads).active.length);
  // Retiring the team agent first asks who teammates talk to instead.
  const nextChoices = held === null ? null : kinNextTeamAgentChoices(held, agentId);
  const contact =
    lead === null ? (held?.contacts?.find((entry) => entry.agentId === agentId) ?? null) : null;
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar
        title="Agent details"
        onClose={() => navigation.goBack()}
        actions={
          lead === null || !canEdit
            ? undefined
            : [
                {
                  accessibilityLabel: `Edit ${lead.name}`,
                  icon: "pencil",
                  onPress: () =>
                    navigation.navigate("KinLeadForm", { environmentId, orgId, agentId }),
                },
              ]
        }
      />
      <ScreenContent surface="screen">
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 20 }}
        >
          {lead !== null ? (
            <>
              <KinLeadProfileView
                lead={lead}
                working={working.has(lead.agentId)}
                access={
                  isRetired ? (
                    canRestore ? (
                      <ListSection footer={kinRestoreCopy(lead.name).detail}>
                        <ListActionRow
                          label="Restore agent"
                          icon="arrow.uturn.backward"
                          loading={retire.busy === lead.agentId}
                          onPress={() => retire.restore(lead)}
                        />
                      </ListSection>
                    ) : null
                  ) : (
                    <KinLeadAccess environmentId={environmentId} lead={lead} />
                  )
                }
              />
              <KinAgentSections environmentId={environmentId} orgId={orgId} lead={lead} />
              <KinLeadNotifications
                environmentId={environmentId}
                orgId={lead.orgId}
                chatId={lead.ownerChatId}
              />
              <KinLeadClearChat
                environmentId={environmentId}
                orgId={lead.orgId}
                chatId={lead.ownerChatId}
                remembers={lead.name}
              />
              {!canRetire || isRetired || retireOffer === null ? null : retireOffer.offered ? (
                <ListSection>
                  {nextChoices === null ? (
                    <ListActionRow
                      label={KIN_RETIRE_ACTION}
                      icon="archivebox"
                      tone="danger"
                      loading={retire.busy === lead.agentId}
                      onPress={() => retire.retire(lead)}
                    />
                  ) : (
                    <Menu
                      title={KIN_RETIRE_NEXT_TEAM_AGENT}
                      accessibilityRole="button"
                      accessibilityLabel={KIN_RETIRE_ACTION}
                      actions={nextChoices.map((next) => ({ id: next.agentId, title: next.name }))}
                      onPressAction={({ nativeEvent }) => {
                        const next = nextChoices.find((one) => one.agentId === nativeEvent.event);
                        if (next !== undefined && retire.busy === null)
                          retire.retire(lead, undefined, next);
                      }}
                    >
                      <View pointerEvents="none" className="bg-grouped-card">
                        <ListRowLayout
                          label={KIN_RETIRE_ACTION}
                          icon="archivebox"
                          tone="danger"
                          disabled={retire.busy === lead.agentId || nextChoices.length === 0}
                        />
                      </View>
                    </Menu>
                  )}
                </ListSection>
              ) : (
                <Text textRole="footnote" className="px-4 text-foreground-muted">
                  {retireOffer.why}
                </Text>
              )}
            </>
          ) : contact !== null ? (
            <>
              <KinLeadContactView contact={contact} />
              <KinLeadNotifications
                environmentId={environmentId}
                orgId={contact.orgId}
                chatId={contact.chatId}
              />
              <KinLeadClearChat
                environmentId={environmentId}
                orgId={contact.orgId}
                chatId={contact.chatId}
                remembers={null}
              />
            </>
          ) : held === null && !AsyncResult.isFailure(result) ? (
            <View
              className="items-center py-12"
              accessible
              accessibilityRole="progressbar"
              accessibilityLabel="Loading agent"
            >
              <AppActivityIndicator />
            </View>
          ) : held === null ? (
            <EmptyState
              variant="plain"
              title={KIN_AGENT_PAGE.loadFailed}
              detail={KIN_CHECK_CONNECTION}
              action={
                <Button
                  tone="secondary"
                  label={KIN_RETRY}
                  onPress={() => appAtomRegistry.refresh(atom)}
                />
              }
            />
          ) : (
            <EmptyState
              variant="plain"
              title="Not one of your agents"
              detail="Only the person who set up an agent can see its details."
            />
          )}
        </ScreenScrollView>
      </ScreenContent>
    </View>
  );
}

/** Read at render: a mute only ends when its time passes, and a re-render reads it again. */
const mutedNow = (chat: KinChatSummary, personId: string) =>
  kinChatMuted(chat, new Set([personId]), Date.now());

/** The viewer's mute for their chat with this lead; nothing until the chat and viewer are known. */
function KinLeadNotifications(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly chatId: KinChatId;
}) {
  const { environmentId } = props;
  const host = useKinHostAt(environmentId);
  const inbox = useAtomValue(kinClient.inbox({ environmentId, input: {} }));
  const canMute = useAtomValue(kinClient.mute.permissionAtom(environmentId));
  const runMute = useAtomCommand(kinClient.mute, "Muting this chat");
  const { personId } = kinFeedViewer(
    host._tag === "host" && host.probe._tag === "ready" ? host.probe.orgs : null,
    props.orgId,
  );
  const chat =
    inbox._tag === "Success"
      ? inbox.value.value.chats.find((held) => held.chatId === props.chatId)
      : undefined;
  if (!canMute || chat === undefined || personId === null) return null;
  const muted = mutedNow(chat, personId);
  return (
    <ListSection title="Notifications">
      <ListToggleRow
        label="Mute notifications"
        value={muted}
        onValueChange={(next) =>
          void runMute({ environmentId, input: { chatId: chat.chatId, muted: next } })
        }
      />
    </ListSection>
  );
}

/** Empties the viewer's chat with this lead, once they confirm; the chat behind shows it. */
function KinLeadClearChat(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly chatId: KinChatId;
  /** The viewer's own lead, which keeps what it remembers; null for someone else's lead. */
  readonly remembers: string | null;
}) {
  const { environmentId } = props;
  const navigation = useNavigation();
  const host = useKinHostAt(environmentId);
  const inbox = useAtomValue(kinClient.inbox({ environmentId, input: {} }));
  const canClear = useAtomValue(kinClient.clear.permissionAtom(environmentId));
  const runClear = useAtomCommand(kinClient.clear, "Clearing this chat");
  const preview = useAtomCommand(kinClient.clearPreview, { reportFailure: false });
  const { personId } = kinFeedViewer(
    host._tag === "host" && host.probe._tag === "ready" ? host.probe.orgs : null,
    props.orgId,
  );
  const chat =
    inbox._tag === "Success"
      ? inbox.value.value.chats.find((held) => held.chatId === props.chatId)
      : undefined;
  // The host decides again on the call; this only hides what it would refuse.
  if (!canClear || chat === undefined || !kinOwnsDirectChat(chat.kind, chat.members, personId))
    return null;
  return (
    <ListSection>
      <ListActionRow
        label={KIN_CLEAR_CHAT_ACTION}
        icon="bubble.left"
        tone="danger"
        onPress={() =>
          // The confirm says what a doc keeps, so it opens once the host has said.
          void preview({ environmentId, input: { chatId: chat.chatId, preview: true } }).then(
            (asked) =>
              Dialog.confirm({
                title: KIN_CLEAR_CHAT_TITLE,
                message: kinClearChatBody(
                  props.remembers,
                  AsyncResult.isSuccess(asked) ? asked.value.keptFiles : undefined,
                ),
                confirmText: KIN_CLEAR_CHAT_ACTION,
                destructive: true,
                onConfirm: () =>
                  void runClear({ environmentId, input: { chatId: chat.chatId } }).then(
                    (result) => {
                      if (!AsyncResult.isSuccess(result)) return;
                      const kept = kinClearChatKept(result.value.keptFiles);
                      if (kept !== null) Dialog.alert(KIN_CLEAR_CHAT_DONE, kept);
                      navigation.goBack();
                    },
                  ),
              }),
          )
        }
      />
    </ListSection>
  );
}

/** Who besides the owner can message this lead, and the way to add or remove a person. */
function KinLeadAccess(props: {
  readonly environmentId: EnvironmentId;
  readonly lead: KinLeadProfile;
}) {
  const { environmentId, lead } = props;
  const host = useKinHostAt(environmentId);
  const target = { orgId: lead.orgId, agentId: lead.agentId };
  const accessAtom = kinClient.leadAccess({ environmentId, input: target });
  const canShare = useAtomValue(kinClient.leadAllow.permissionAtom(environmentId));
  const access = useAtomValue(canShare ? accessAtom : noAccessAtom);
  const people = useAtomValue(
    canShare ? kinClient.people({ environmentId, input: { orgId: lead.orgId } }) : noPeopleAtom,
  );
  const allow = useAtomCommand(kinClient.leadAllow, { reportFailure: false });
  const disallow = useAtomCommand(kinClient.leadDisallow, { reportFailure: false });
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ readonly text: string; readonly failed: boolean } | null>(
    null,
  );
  if (!canShare) return null;
  const { personId } = kinFeedViewer(
    host._tag === "host" && host.probe._tag === "ready" ? host.probe.orgs : null,
    lead.orgId,
  );
  // What was last read stays up while a change is read again.
  const read = Option.getOrNull(AsyncResult.value(access));
  const allowed = read?.people ?? null;
  // The team agent is everyone's: no one is added or removed there.
  const everyone = read?.everyone === true;
  const candidates = kinLeadAccessCandidates(
    everyone ? [] : (Option.getOrNull(AsyncResult.value(people))?.people ?? []),
    allowed ?? [],
    personId,
  );

  const change = async (
    person: {
      readonly personId: KinPersonId;
      readonly displayName: string;
      readonly ownerLevel?: boolean | undefined;
    },
    on: boolean,
  ) => {
    if (busy !== null) return;
    setBusy(person.personId);
    setNote(null);
    const input = { ...target, personId: person.personId };
    const result = await (on ? allow : disallow)({ environmentId, input });
    setBusy(null);
    if (AsyncResult.isSuccess(result)) {
      appAtomRegistry.refresh(accessAtom);
      setNote({
        text: kinLeadAccessChanged(person.displayName, lead.name, on, person.ownerLevel),
        failed: false,
      });
      return;
    }
    setNote({
      text: kinLeadAccessProblem(
        AsyncResult.isFailure(result) ? squashAtomCommandFailure(result) : null,
      ),
      failed: true,
    });
  };

  const askAdd = () =>
    Dialog.alert(`Who can message ${lead.name}?`, undefined, [
      ...candidates.map((person) => ({
        text: person.displayName,
        onPress: () => void change(person, true),
      })),
      { text: "Cancel", style: "cancel" as const },
    ]);

  const askRemove = (person: AccessPerson) =>
    Dialog.confirm({
      title: `Remove ${person.displayName}?`,
      message: KIN_AGENTS_COPY.removeAccess(person.displayName, lead.name, person.ownerLevel),
      confirmText: "Remove",
      destructive: true,
      onConfirm: () => void change(person, false),
    });

  const intro = (lead.intro ?? "").trim();
  const footer =
    note !== null
      ? note.text
      : allowed === null || everyone || allowed.length === 0
        ? undefined
        : intro === ""
          ? KIN_AGENTS_COPY.nameOnly
          : KIN_AGENTS_COPY.seesIntro(intro);
  return (
    <ListSection title="Who can message" footer={footer}>
      {allowed === null ? (
        <View className="px-4 py-3">
          <Text textRole="body" className="text-foreground-muted">
            {AsyncResult.isFailure(access) ? KIN_AGENTS_COPY.accessFailed : "Loading…"}
          </Text>
        </View>
      ) : everyone || allowed.length === 0 ? (
        <View className="px-4 py-3">
          <Text textRole="body" className="text-foreground-muted">
            {everyone ? KIN_LEAD_EVERYONE : KIN_AGENTS_COPY.onlyOwners}
          </Text>
        </View>
      ) : (
        allowed.map((person, index) => (
          <View
            key={person.personId}
            className={index === 0 ? undefined : "border-t border-border-subtle"}
          >
            <ListRow
              label={person.displayName}
              leading={
                <KinAvatar
                  avatar={{ kind: "person", seed: `person:${person.personId}` }}
                  size="small"
                />
              }
              detail={busy === person.personId ? "Removing…" : "Remove"}
              disabled={busy !== null}
              onPress={() => askRemove(person)}
            />
          </View>
        ))
      )}
      {allowed !== null && candidates.length > 0 ? (
        <View className="border-t border-border-subtle">
          <ListActionRow
            label="Add a person"
            icon="plus"
            disabled={busy !== null}
            onPress={askAdd}
          />
        </View>
      ) : null}
    </ListSection>
  );
}

/** A lead someone else set up, as a person let message it sees it. */
function KinLeadContactView({ contact }: { readonly contact: KinLeadContact }) {
  return (
    <>
      <View className="items-center gap-3 pt-2">
        <KinAvatar avatar={kinAgentAvatar(contact.agentId)} size="large" />
        <Text textRole="title" className="text-center font-t3-bold text-foreground">
          {contact.name}
        </Text>
      </View>
      <ListSection title="About" footer={kinLeadOwnerSeesLine(contact.ownerName)}>
        <View className="px-4 py-3">
          <Text textRole="body" selectable className="text-foreground">
            {kinLeadContactAbout(contact)}
          </Text>
        </View>
      </ListSection>
    </>
  );
}

/** Also drawn from fixtures in the component catalog. */
export function KinLeadProfileView({
  lead,
  working = false,
  access,
}: {
  readonly lead: KinLeadProfile;
  /** On a live run now, from the chat list (`kinWorkingAgents`). */
  readonly working?: boolean;
  /** The owner's "Who can message" section, placed under what the lead is for. */
  readonly access?: ReactNode;
}) {
  const charter = lead.charter.trim();
  const area = kinDomainLabel(lead.domain);
  // A lead named after its area would say the same word twice.
  const retired = lead.retired;
  const detail = kinSentenceParts([
    area.toLowerCase() === lead.name.trim().toLowerCase() ? null : area,
    retired !== undefined
      ? kinRetiredWhenNow(retired.at)
      : lead.paused !== undefined
        ? "Paused"
        : working
          ? "Working now"
          : null,
  ]);
  return (
    <>
      <View className="items-center gap-3 pt-2">
        <KinAvatar avatar={kinAgentAvatar(lead.agentId)} size="large" />
        <View className="items-center gap-1">
          <Text textRole="title" className="text-center font-t3-bold text-foreground">
            {lead.name}
          </Text>
          {detail === null ? null : (
            <Text textRole="footnote" className="text-center text-foreground-muted">
              {detail}
            </Text>
          )}
        </View>
      </View>
      <ListSection title="Responsible for">
        <View className="px-4 py-3">
          <Text
            textRole="body"
            selectable
            className={charter === "" ? "text-foreground-muted" : "text-foreground"}
          >
            {charter === ""
              ? "Nothing written yet. Add a few lines so it knows what to focus on."
              : charter}
          </Text>
        </View>
      </ListSection>
      {access}
      <ListSection title={retired === undefined ? "In hand" : "On hold"}>
        {lead.tracking.length === 0 ? (
          <View className="px-4 py-3">
            <Text textRole="body" className="text-foreground-muted">
              {retired === undefined
                ? "Nothing right now. Reminders, follow-ups and work it starts show up here."
                : KIN_AGENT_PAGE.nothingWaiting}
            </Text>
          </View>
        ) : (
          lead.tracking.map((item, index) => (
            // Titles can repeat and items carry no id; the host's order is stable.
            // oxlint-disable-next-line react/no-array-index-key
            <View key={index} className={index === 0 ? undefined : "border-t border-border-subtle"}>
              <ListRowLayout label={item.title} description={kinLeadTrackingDetail(item)} />
            </View>
          ))
        )}
      </ListSection>
    </>
  );
}
