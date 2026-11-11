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
  kinLeadAccessCandidates,
  kinLeadAccessChanged,
  kinLeadOwnerSeesLine,
  kinLeadAccessProblem,
  kinLeadModelName,
  kinLeadTrackingDetail,
} from "@t3tools/client-runtime/kin/kinLeadPresentation";
import { kinFeedViewer } from "@t3tools/client-runtime/kin/kinChatFeed";
import {
  KIN_CLEAR_CHAT_ACTION,
  KIN_CLEAR_CHAT_TITLE,
  kinClearChatBody,
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
import { ListRow } from "../../components/ui/ListRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { appAtomRegistry } from "../../state/atom-registry";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { KinAvatar } from "./components/KinAvatar";
import { kinClient } from "./state/kinClient";
import { useKinHostAt } from "./state/useKinHost";

export type KinLeadParams = {
  readonly environmentId: string;
  readonly orgId: string;
  readonly agentId: string;
};

const kinSentenceParts = (parts: ReadonlyArray<string | null>) =>
  parts.filter((part) => part !== null).join(" · ") || null;

type AccessResult = AsyncResult.AsyncResult<KinLeadAccessResult, unknown>;
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
        <AppBar title="Lead details" onClose={() => navigation.goBack()} />
        <ScreenContent surface="screen">
          <EmptyState
            variant="plain"
            title="This link doesn't name a lead"
            detail="Open a lead from its chat."
          />
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
  const atom = kinClient.leads({ environmentId, input: { orgId } });
  const result = useAtomValue(atom);
  const canEdit = useAtomValue(kinClient.leadUpdate.permissionAtom(environmentId));
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const lead = AsyncResult.isSuccess(result)
    ? (result.value.leads.find((held) => held.agentId === agentId) ?? null)
    : null;
  const contact =
    AsyncResult.isSuccess(result) && lead === null
      ? (result.value.contacts?.find((held) => held.agentId === agentId) ?? null)
      : null;
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar
        title="Lead details"
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
                modelName={kinLeadModelName(lead.model, providers)}
                access={<KinLeadAccess environmentId={environmentId} lead={lead} />}
              />
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
          ) : AsyncResult.isInitial(result) ? (
            <View
              className="items-center py-12"
              accessible
              accessibilityRole="progressbar"
              accessibilityLabel="Loading lead"
            >
              <AppActivityIndicator />
            </View>
          ) : AsyncResult.isFailure(result) ? (
            <EmptyState
              variant="plain"
              title="Couldn't load this lead"
              detail="Check your connection to the server and try again."
              action={
                <Button
                  tone="secondary"
                  label="Try again"
                  onPress={() => appAtomRegistry.refresh(atom)}
                />
              }
            />
          ) : (
            <EmptyState
              variant="plain"
              title="Not one of your leads"
              detail="Only the person who set up a lead can see its details."
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
          Dialog.confirm({
            title: KIN_CLEAR_CHAT_TITLE,
            message: kinClearChatBody(props.remembers),
            confirmText: KIN_CLEAR_CHAT_ACTION,
            destructive: true,
            onConfirm: () =>
              void runClear({ environmentId, input: { chatId: chat.chatId } }).then((result) => {
                if (AsyncResult.isSuccess(result)) navigation.goBack();
              }),
          })
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
  const allowed = Option.getOrNull(AsyncResult.value(access))?.people ?? null;
  const candidates = kinLeadAccessCandidates(
    Option.getOrNull(AsyncResult.value(people))?.people ?? [],
    allowed ?? [],
    personId,
  );

  const change = async (
    person: { readonly personId: KinPersonId; readonly displayName: string },
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
      setNote({ text: kinLeadAccessChanged(person.displayName, lead.name, on), failed: false });
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

  const askRemove = (person: { readonly personId: KinPersonId; readonly displayName: string }) =>
    Dialog.confirm({
      title: `Remove ${person.displayName}?`,
      message: `${person.displayName} keeps their chat with ${lead.name} to read, but can't send it anything more. You can add them back any time.`,
      confirmText: "Remove",
      destructive: true,
      onConfirm: () => void change(person, false),
    });

  const intro = (lead.intro ?? "").trim();
  const footer =
    note !== null
      ? note.text
      : allowed === null || allowed.length === 0
        ? undefined
        : intro === ""
          ? "They see its name only. Add what teammates see when you edit this lead."
          : `They see its name and this: ${intro}`;
  return (
    <ListSection title="Who can message" footer={footer}>
      {allowed === null ? (
        <View className="px-4 py-3">
          <Text textRole="body" className="text-foreground-muted">
            {AsyncResult.isFailure(access) ? "Couldn't load who can message it." : "Loading…"}
          </Text>
        </View>
      ) : allowed.length === 0 ? (
        <View className="px-4 py-3">
          <Text textRole="body" className="text-foreground-muted">
            Only you.
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
  const intro = contact.intro.trim();
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
            {intro === "" ? `Message ${contact.name} here like a colleague.` : intro}
          </Text>
        </View>
      </ListSection>
    </>
  );
}

/** Also drawn from fixtures in the component catalog. */
export function KinLeadProfileView({
  lead,
  modelName,
  access,
}: {
  readonly lead: KinLeadProfile;
  /** The model as the model picker names it. */
  readonly modelName: string;
  /** The owner's "Who can message" section, placed under what the lead is for. */
  readonly access?: ReactNode;
}) {
  const charter = lead.charter.trim();
  const area = kinDomainLabel(lead.domain);
  // A lead named after its area would say the same word twice.
  const detail = kinSentenceParts([
    area.toLowerCase() === lead.name.trim().toLowerCase() ? null : area,
    lead.working ? "Working now" : null,
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
      <ListSection title="In hand" footer={`Thinks with ${modelName}.`}>
        {lead.tracking.length === 0 ? (
          <View className="px-4 py-3">
            <Text textRole="body" className="text-foreground-muted">
              Nothing right now. Reminders, follow-ups and work it starts show up here.
            </Text>
          </View>
        ) : (
          lead.tracking.map((item, index) => (
            <View
              key={`${item.kind}:${item.dueAt ?? ""}:${item.chatId ?? ""}:${item.title}`}
              className={index === 0 ? undefined : "border-t border-border-subtle"}
            >
              <ListRowLayout label={item.title} description={kinLeadTrackingDetail(item)} />
            </View>
          ))
        )}
      </ListSection>
    </>
  );
}
