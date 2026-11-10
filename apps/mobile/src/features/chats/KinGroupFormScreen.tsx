import { useAtomValue } from "@effect/atom-react";
import { useNavigation, usePreventRemove, type StaticScreenProps } from "@react-navigation/native";
import {
  EnvironmentId,
  KinChatId,
  KinOrgId,
  type KinAgentId,
  type KinChatMembersResult,
  type KinPersonId,
  type KinPrincipal,
} from "@t3tools/contracts";
import {
  KIN_GROUP_NAME_MAX,
  kinGroupNameCheck,
  kinGroupProblem,
} from "@t3tools/client-runtime/kin/kinGroups";
import { kinDomainLabel } from "@t3tools/client-runtime/kin/kinLeadPresentation";
import { kinAgentAvatar } from "@t3tools/client-runtime/kin/kinScreenState";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import { useRef, useState } from "react";
import { TextInput, View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { ListSection } from "../../components/ui/ListSection";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { SelectionRow } from "../../components/ui/SelectionRow";
import { appAtomRegistry } from "../../state/atom-registry";
import { useAtomCommand } from "../../state/use-atom-command";
import { KinAvatar } from "./components/KinAvatar";
import { kinClient } from "./state/kinClient";
import { useKinHostAt } from "./state/useKinHost";

export type KinGroupFormParams = {
  readonly environmentId: string;
  readonly orgId: string;
  /** The group to add to; unset makes a new one. */
  readonly chatId?: string;
};

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeOrgId = Schema.decodeUnknownOption(KinOrgId);
const decodeChatId = Schema.decodeUnknownOption(KinChatId);

type MembersResult = AsyncResult.AsyncResult<KinChatMembersResult, unknown> | null;
const noMembersAtom: Atom.Atom<MembersResult> = Atom.make<MembersResult>(null);

/** Makes a group from a name and any mix of leads and people, or adds more to one. */
export function KinGroupFormScreen({ route }: StaticScreenProps<KinGroupFormParams>) {
  const navigation = useNavigation();
  const environmentId = Option.getOrNull(decodeEnvironmentId(route.params.environmentId));
  const orgId = Option.getOrNull(decodeOrgId(route.params.orgId));
  const chatId =
    route.params.chatId === undefined ? null : Option.getOrNull(decodeChatId(route.params.chatId));
  if (environmentId === null || orgId === null || (route.params.chatId !== undefined && !chatId)) {
    return (
      <View collapsable={false} className="flex-1 bg-screen">
        <AppBar title="Group" onClose={() => navigation.goBack()} />
        <ScreenContent surface="screen">
          <EmptyState
            variant="plain"
            title="This link doesn't name a group"
            detail="Open a group from your chats."
          />
        </ScreenContent>
      </View>
    );
  }
  return <GroupForm environmentId={environmentId} orgId={orgId} chatId={chatId} />;
}

function GroupForm(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly chatId: KinChatId | null;
}) {
  const navigation = useNavigation();
  const { environmentId, orgId, chatId } = props;
  const creating = chatId === null;
  const host = useKinHostAt(environmentId);
  const me = new Set(
    host._tag === "host" && host.probe._tag === "ready"
      ? host.probe.orgs.me.map((entry) => entry.personId as string)
      : [],
  );
  const leadsResult = useAtomValue(kinClient.leads({ environmentId, input: { orgId } }));
  const peopleResult = useAtomValue(kinClient.people({ environmentId, input: { orgId } }));
  // A new group has no members to leave out of the lists.
  const membersAtom =
    chatId === null ? null : kinClient.chatMembers({ environmentId, input: { chatId } });
  const membersResult = useAtomValue(membersAtom ?? noMembersAtom);
  const allowed = useAtomValue(
    (creating ? kinClient.groupCreate : kinClient.groupAddMember).permissionAtom(environmentId),
  );
  const create = useAtomCommand(kinClient.groupCreate, { reportFailure: false });
  const add = useAtomCommand(kinClient.groupAddMember, { reportFailure: false });

  const [name, setName] = useState("");
  // In the order picked: the first lead picked answers when a message names no one.
  const [agentIds, setAgentIds] = useState<ReadonlyArray<KinAgentId>>([]);
  const [personIds, setPersonIds] = useState<ReadonlyArray<KinPersonId>>([]);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<{
    readonly field: "name" | null;
    readonly text: string;
  } | null>(null);
  const saved = useRef(false);

  const dirty = name.trim() !== "" || agentIds.length > 0 || personIds.length > 0;
  usePreventRemove(dirty || saving, ({ data }) => {
    if (saved.current) {
      navigation.dispatch(data.action);
      return;
    }
    if (saving) return;
    Dialog.alert(creating ? "Discard this group?" : "Discard your picks?", undefined, [
      { text: "Keep editing", style: "cancel" },
      { text: "Discard", style: "destructive", onPress: () => navigation.dispatch(data.action) },
    ]);
  });

  const inGroup = new Set(
    membersResult !== null && AsyncResult.isSuccess(membersResult)
      ? membersResult.value.members.flatMap((member) =>
          member.leftAt !== null
            ? []
            : [
                member.principal._tag === "agent"
                  ? member.principal.agentId
                  : member.principal.personId,
              ],
        )
      : [],
  );
  const leads = AsyncResult.isSuccess(leadsResult)
    ? leadsResult.value.leads.filter((lead) => !inGroup.has(lead.agentId))
    : [];
  const people = AsyncResult.isSuccess(peopleResult)
    ? peopleResult.value.people.filter(
        (person) => !me.has(person.personId) && !inGroup.has(person.personId),
      )
    : [];
  const loading =
    AsyncResult.isInitial(leadsResult) ||
    AsyncResult.isInitial(peopleResult) ||
    (membersResult !== null && AsyncResult.isInitial(membersResult));
  const picked = agentIds.length + personIds.length;

  const toggle = <A,>(list: ReadonlyArray<A>, id: A) =>
    list.includes(id) ? list.filter((held) => held !== id) : [...list, id];

  const fail = (result: unknown, doing: string) =>
    setProblem({
      field: null,
      text: kinGroupProblem(
        AsyncResult.isAsyncResult(result) && AsyncResult.isFailure(result)
          ? squashAtomCommandFailure(result)
          : null,
        doing,
      ),
    });

  const save = async () => {
    if (saving) return;
    if (chatId === null) {
      const checked = kinGroupNameCheck(name);
      if (!checked.ok) {
        setProblem({ field: "name", text: checked.problem });
        return;
      }
      setSaving(true);
      const result = await create({
        environmentId,
        input: { orgId, title: checked.title, agentIds, personIds },
      });
      setSaving(false);
      if (!AsyncResult.isSuccess(result)) {
        fail(result, "make this group");
        return;
      }
      saved.current = true;
      navigation.goBack();
      navigation.navigate("KinChat", { environmentId, orgId, chatId: result.value.chatId });
      return;
    }
    const principals: ReadonlyArray<KinPrincipal> = [
      ...agentIds.map((agentId) => ({ _tag: "agent" as const, agentId })),
      ...personIds.map((personId) => ({ _tag: "person" as const, personId })),
    ];
    setSaving(true);
    for (const principal of principals) {
      const result = await add({ environmentId, input: { chatId, principal } });
      if (AsyncResult.isSuccess(result)) continue;
      setSaving(false);
      // Those already added stay added; the list drops them so a second try adds only the rest.
      if (membersAtom !== null) appAtomRegistry.refresh(membersAtom);
      fail(result, "add to this group");
      return;
    }
    setSaving(false);
    saved.current = true;
    if (membersAtom !== null) appAtomRegistry.refresh(membersAtom);
    navigation.goBack();
  };

  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar
        title={creating ? "New group" : "Add to group"}
        onClose={() => navigation.goBack()}
        confirm={{
          label: creating ? "Create" : "Add",
          onPress: () => void save(),
          loading: saving,
          disabled: !allowed || saving || (!creating && picked === 0),
        }}
      />
      <ScreenContent surface="screen">
        <ScreenScrollView
          className="flex-1"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 20 }}
        >
          {problem?.field === null ? <ErrorBanner message={problem.text} /> : null}
          {allowed ? null : (
            <Text textRole="footnote" className="px-2 text-foreground-muted">
              This phone isn't allowed to change groups on this server.
            </Text>
          )}
          {creating ? (
            <View className="gap-2">
              <ListSection>
                <View className="gap-2 px-4 py-3">
                  <Text className="text-sm text-foreground-muted">Name</Text>
                  <TextInput
                    accessibilityLabel="Group name"
                    value={name}
                    editable={allowed && !saving}
                    autoFocus
                    autoCapitalize="sentences"
                    maxLength={KIN_GROUP_NAME_MAX}
                    onChangeText={(text) => {
                      setName(text);
                      setProblem(null);
                    }}
                    textAlignVertical="center"
                    placeholder="Launch week"
                    placeholderTextColorClassName="accent-placeholder"
                    className="min-h-8 font-sans text-base text-foreground"
                  />
                </View>
              </ListSection>
              {problem?.field === "name" ? (
                <Text
                  textRole="footnote"
                  accessibilityLiveRegion="polite"
                  className="px-4 text-danger-foreground"
                >
                  {problem.text}
                </Text>
              ) : null}
            </View>
          ) : null}
          {loading ? (
            <View
              className="items-center py-8"
              accessible
              accessibilityRole="progressbar"
              accessibilityLabel="Loading your leads and people"
            >
              <AppActivityIndicator />
            </View>
          ) : (
            <>
              {leads.length === 0 ? null : (
                <ListSection
                  title="Leads"
                  footer={
                    creating
                      ? "The first lead you pick answers when a message names no one. Name another with @ to ask it instead."
                      : undefined
                  }
                >
                  {leads.map((lead, index) => (
                    <SelectionRow
                      key={lead.agentId}
                      role="checkbox"
                      title={lead.name}
                      subtitle={
                        agentIds[0] === lead.agentId && creating
                          ? "Answers when no one is named"
                          : kinDomainLabel(lead.domain)
                      }
                      leading={<KinAvatar avatar={kinAgentAvatar(lead.agentId)} size="small" />}
                      selected={agentIds.includes(lead.agentId)}
                      disabled={!allowed || saving}
                      isLast={index === leads.length - 1}
                      onPress={() => setAgentIds((held) => toggle(held, lead.agentId))}
                    />
                  ))}
                </ListSection>
              )}
              {people.length === 0 ? null : (
                <ListSection
                  title="People"
                  footer="People in a group read everything in it, and can ask its leads to talk things through. Only you can have a lead start work."
                >
                  {people.map((person, index) => (
                    <SelectionRow
                      key={person.personId}
                      role="checkbox"
                      title={person.displayName}
                      leading={
                        <KinAvatar
                          avatar={{ kind: "person", seed: `person:${person.personId}` }}
                          size="small"
                        />
                      }
                      selected={personIds.includes(person.personId)}
                      disabled={!allowed || saving}
                      isLast={index === people.length - 1}
                      onPress={() => setPersonIds((held) => toggle(held, person.personId))}
                    />
                  ))}
                </ListSection>
              )}
              {leads.length === 0 && people.length === 0 ? (
                <EmptyState
                  variant="plain"
                  title={creating ? "No one to add yet" : "Everyone is already here"}
                  detail={
                    creating
                      ? "Make a lead or invite a person first. You can still make the group and add them later."
                      : "Every lead and person you could add is in this group."
                  }
                />
              ) : null}
            </>
          )}
        </ScreenScrollView>
      </ScreenContent>
    </View>
  );
}
