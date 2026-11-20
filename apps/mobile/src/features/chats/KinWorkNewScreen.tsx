import { useAtomValue } from "@effect/atom-react";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  KIN_WORK_NEW_COPY,
  KIN_WORK_NOTES_MAX,
  kinWorkOnlyOwner,
  KIN_WORK_REPEAT,
  createKinWorkActions,
  kinSameRepeat,
  kinWorkAssignees,
  kinWorkDraftCheck,
  kinWorkDraftFor,
  kinWorkDraftHint,
  kinWorkDraftWords,
  kinWorkTitleCount,
  kinWorkTitleTooLong,
  kinWorkHostClients,
  kinWorkDueChoices,
  kinWorkDueLabel,
  kinWorkPrincipalKey,
  type KinWorkDraft,
} from "@t3tools/client-runtime/kin/kinWork";
import { KIN_CLIENTS, kinNewTaskChoices } from "@t3tools/client-runtime/kin/kinWorkClients";
import { kinAccessMeAtom } from "@t3tools/client-runtime/kin/kinAccess";
import { EnvironmentId, KinOrgId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { type ComponentRef, useRef, useState } from "react";
import { TextInput, View } from "react-native";

import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { Chip } from "../../components/ui/Chip";
import { EmptyState } from "../../components/ui/EmptyState";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { ListSection } from "../../components/ui/ListSection";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { uuidv4 } from "../../lib/uuid";
import { useAtomCommand } from "../../state/use-atom-command";
import { KinAvatar } from "./components/KinAvatar";
import { KinWorkPlacePicker } from "./components/KinWorkPlacePicker";
import { KinWorkSideRow } from "./components/KinWorkTaskMenus";
import { kinWorkRefParam, type KinWorkParams } from "./KinWorkScreen";
import { kinClient } from "./state/kinClient";
import {
  useKinWork,
  useKinWorkChoices,
  useKinWorkDirectory,
  type KinWorkTarget,
} from "./state/useKinWork";
import { KinGateView, KinWorkAboveKeyboard } from "./components/KinWorkPieces";
import { useKinGate } from "./state/useKinHost";

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeOrgId = Schema.decodeUnknownOption(KinOrgId);

/** "Friday, Fri, Nov 13"; "Today" needs no date said after it. */
function dueChoiceLabel(
  choice: { readonly label: string; readonly day: string },
  now: Date,
  zone: string | null,
) {
  const day = kinWorkDueLabel(choice.day, now, zone);
  return day === choice.label ? day : `${choice.label}, ${day}`;
}

/** A short form: what, who and when. Anything longer is better said to a lead in chat. */
export function KinWorkNewScreen({ route }: StaticScreenProps<KinWorkParams>) {
  const navigation = useNavigation();
  const environmentId = Option.getOrNull(decodeEnvironmentId(route.params.environmentId));
  const orgId = Option.getOrNull(decodeOrgId(route.params.orgId));
  if (environmentId === null || orgId === null) {
    return (
      <View collapsable={false} className="flex-1 bg-screen">
        <AppBar title={KIN_WORK_NEW_COPY.title} onClose={() => navigation.goBack()} />
        <ScreenContent surface="screen">
          <ScreenScrollView
            className="flex-1"
            contentInsetAdjustmentBehavior="automatic"
            contentContainerStyle={{ padding: 16 }}
          >
            <EmptyState
              variant="plain"
              title="This link doesn't open anything"
              detail="Add a task from Work in your Kin chats."
            />
          </ScreenScrollView>
        </ScreenContent>
      </View>
    );
  }
  return (
    <KinWorkNewForm
      environmentId={environmentId}
      orgId={orgId}
      start={kinWorkDraftFor({
        party: kinWorkRefParam(route.params.party, route.params.partyName),
        project: kinWorkRefParam(route.params.project, route.params.projectName),
        side:
          route.params.side === "theirs" ? "theirs" : route.params.side === "ours" ? "ours" : null,
        deal: kinWorkRefParam(route.params.deal, route.params.dealName),
      })}
    />
  );
}

function KinWorkNewForm(props: KinWorkTarget & { readonly start: KinWorkDraft }) {
  const navigation = useNavigation();
  const { environmentId, orgId } = props;
  const target = { environmentId, orgId };
  const gate = useKinGate(kinClient.workCreate.permissionStateAtom(environmentId), environmentId);
  const allowed = gate === null;
  const { orgs, people, joined, invited, names } = useKinWorkDirectory(target, allowed);
  const create = useAtomCommand(kinClient.workCreate, { reportFailure: false });
  const scroll = useRef<ComponentRef<typeof ScreenScrollView>>(null);
  const [aboveKeyboard] = useState(
    () => (node: ComponentRef<typeof View>) =>
      scroll.current?.scrollResponderScrollNativeHandleToKeyboard(node, 8, true),
  );
  const assign = useAtomCommand(kinClient.workAssign, { reportFailure: false });
  const [actions] = useState(() =>
    createKinWorkActions({
      orgId,
      create: (input) => create({ environmentId, input }),
      assign: (input) => assign({ environmentId, input }),
      reread: () => undefined,
    }),
  );
  // One id for the form's life: trying again after a dropped answer never adds a second task.
  const [requestId] = useState(uuidv4);
  const [opened] = useState(() => new Date());
  const [draft, setDraft] = useState<KinWorkDraft>(props.start);
  const work = useKinWork(target);
  // An older server has no clients or projects to put a task under.
  const hostClients = kinWorkHostClients(work._tag === "ready" ? work.live.summary : null);
  const choices = kinNewTaskChoices(
    useKinWorkChoices(target, allowed && hostClients),
    useAtomValue(kinAccessMeAtom(connectionAtomRuntime, environmentId)),
  );
  const offersClient = choices.clients.length > 0 || draft.party !== null;
  const offersProject = choices.projects.length > 0 || draft.project !== null;
  const words = kinWorkDraftWords(draft);
  const titleCount = kinWorkTitleCount(draft.title);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const assignees = kinWorkAssignees({
    orgs,
    orgId,
    people,
    joined,
    invited,
    names,
    current: null,
  });
  const everyone = [...assignees.people, ...assignees.leads];
  const ownerKey =
    draft.owner === null ? (assignees.people[0]?.key ?? null) : kinWorkPrincipalKey(draft.owner);
  const checked = kinWorkDraftCheck(draft);
  const hint = kinWorkDraftHint(draft, names);

  const save = async () => {
    if (saving || !allowed) return;
    if (!checked.ok) return setProblem(checked.problem);
    setSaving(true);
    setProblem(null);
    const outcome = await actions.add(checked.input, requestId);
    setSaving(false);
    if (outcome.ok) navigation.goBack();
    else setProblem(outcome.problem);
  };

  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar
        // The bar is too narrow for the client's name, which the Client row below carries.
        title={
          draft.party === null || draft.side === null
            ? words.title
            : draft.side === "theirs"
              ? KIN_CLIENTS.theyOwe
              : KIN_CLIENTS.weOwe
        }
        onClose={() => navigation.goBack()}
        confirm={{
          label: KIN_WORK_NEW_COPY.submit,
          onPress: () => void save(),
          loading: saving,
          disabled: !allowed || saving || draft.title.trim() === "",
        }}
      />
      <ScreenContent surface="screen">
        <ScreenScrollView
          ref={scroll}
          className="flex-1"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          automaticallyAdjustKeyboardInsets
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 20 }}
        >
          {gate !== null ? (
            <KinGateView gate={gate} refused={kinWorkOnlyOwner("tasks")} label={words.title} />
          ) : (
            <>
              {problem === null ? null : <ErrorBanner message={problem} />}
              <ListSection>
                <View className="gap-2 px-4 py-3">
                  <Text className="text-sm text-foreground-muted">{words.titleLabel}</Text>
                  <TextInput
                    accessibilityLabel={words.titleLabel}
                    value={draft.title}
                    editable={!saving}
                    autoFocus
                    autoCapitalize="sentences"
                    returnKeyType="done"
                    onChangeText={(title) => setDraft({ ...draft, title })}
                    textAlignVertical="center"
                    placeholder={words.titlePlaceholder}
                    placeholderTextColorClassName="accent-placeholder"
                    className="min-h-8 font-sans text-base text-foreground"
                  />
                  {titleCount === null ? null : (
                    <Text
                      textRole="footnote"
                      className={
                        kinWorkTitleTooLong(draft.title)
                          ? "text-danger-foreground tabular-nums"
                          : "text-foreground-muted tabular-nums"
                      }
                    >
                      {titleCount}
                    </Text>
                  )}
                </View>
              </ListSection>
              <View className="gap-2">
                <Text className="px-2 text-sm text-foreground-muted">
                  {KIN_WORK_NEW_COPY.ownerLabel}
                </Text>
                <View className="flex-row flex-wrap gap-2">
                  {everyone.map((to) => (
                    <Chip
                      key={to.key}
                      leading={<KinAvatar avatar={to.avatar} size="mini" />}
                      label={to.invited ? `${to.name}, invited` : to.name}
                      selected={to.key === ownerKey}
                      disabled={saving || to.invited === true}
                      onPress={() => setDraft({ ...draft, owner: to.principal })}
                    />
                  ))}
                </View>
                {hint === null ? null : (
                  <Text textRole="footnote" className="px-2 text-foreground-muted">
                    {hint}
                  </Text>
                )}
              </View>
              <View className="gap-2">
                <Text className="px-2 text-sm text-foreground-muted">
                  {KIN_WORK_NEW_COPY.dueLabel}
                </Text>
                <View className="flex-row flex-wrap gap-2">
                  <Chip
                    label={KIN_WORK_NEW_COPY.noDue}
                    selected={draft.due === null}
                    disabled={saving}
                    onPress={() => setDraft({ ...draft, due: null, repeat: null })}
                  />
                  {kinWorkDueChoices(opened, names.zone).map((choice) => (
                    <Chip
                      key={choice.day}
                      label={choice.label}
                      accessibilityLabel={dueChoiceLabel(choice, opened, names.zone)}
                      selected={draft.due === choice.day}
                      disabled={saving}
                      onPress={() => setDraft({ ...draft, due: choice.day })}
                    />
                  ))}
                </View>
              </View>
              {draft.due === null ? null : (
                <View className="gap-2">
                  <Text className="px-2 text-sm text-foreground-muted">
                    {KIN_WORK_REPEAT.label}
                  </Text>
                  <View className="flex-row flex-wrap gap-2">
                    <Chip
                      label={KIN_WORK_REPEAT.never}
                      selected={draft.repeat === null}
                      disabled={saving}
                      onPress={() => setDraft({ ...draft, repeat: null })}
                    />
                    {KIN_WORK_REPEAT.choices.map((choice) => (
                      <Chip
                        key={choice.label}
                        label={choice.label}
                        selected={kinSameRepeat(choice.rule, draft.repeat)}
                        disabled={saving}
                        onPress={() => setDraft({ ...draft, repeat: choice.rule })}
                      />
                    ))}
                  </View>
                  {draft.repeat === null ? null : (
                    <Text textRole="footnote" className="px-2 text-foreground-muted">
                      {KIN_WORK_REPEAT.note}
                    </Text>
                  )}
                </View>
              )}
              {!hostClients || (!offersClient && !offersProject) ? null : (
                <KinWorkAboveKeyboard value={aboveKeyboard}>
                  <ListSection>
                    {!offersClient ? null : (
                      <KinWorkPlacePicker
                        target={target}
                        noun="client"
                        icon="person.2"
                        label={KIN_WORK_NEW_COPY.clientLabel}
                        held={draft.party}
                        choices={choices.clients}
                        disabled={saving}
                        // A deal belongs to its client: another client leaves it.
                        onPick={(party) => setDraft({ ...draft, party, deal: null })}
                      />
                    )}
                    {draft.party === null ? null : (
                      <KinWorkSideRow
                        side={draft.side}
                        disabled={saving}
                        onPick={(side) => setDraft({ ...draft, side })}
                      />
                    )}
                    {!offersProject ? null : (
                      <KinWorkPlacePicker
                        target={target}
                        noun="project"
                        icon="folder"
                        label={KIN_WORK_NEW_COPY.projectLabel}
                        held={draft.project}
                        choices={choices.projects}
                        disabled={saving}
                        onPick={(project) => setDraft({ ...draft, project })}
                      />
                    )}
                  </ListSection>
                </KinWorkAboveKeyboard>
              )}
              {draft.party === null || draft.side === null ? null : (
                <ListSection>
                  <View className="gap-2 px-4 py-3">
                    {draft.deal == null ? null : (
                      <Text className="text-sm text-foreground-muted">
                        {`${KIN_WORK_NEW_COPY.dealLabel}: ${draft.deal.title}`}
                      </Text>
                    )}
                    <Text className="text-sm text-foreground-muted">
                      {KIN_WORK_NEW_COPY.fromLabel}
                    </Text>
                    <TextInput
                      accessibilityLabel={KIN_WORK_NEW_COPY.fromLabel}
                      value={draft.from ?? ""}
                      editable={!saving}
                      maxLength={280}
                      onChangeText={(from) => setDraft({ ...draft, from })}
                      placeholder={KIN_WORK_NEW_COPY.fromPlaceholder}
                      placeholderTextColorClassName="accent-placeholder"
                      className="font-sans text-base text-foreground"
                    />
                  </View>
                </ListSection>
              )}
              <ListSection>
                <View className="gap-2 px-4 py-3">
                  <Text className="text-sm text-foreground-muted">
                    {KIN_WORK_NEW_COPY.notesLabel}
                  </Text>
                  <TextInput
                    accessibilityLabel={KIN_WORK_NEW_COPY.notesLabel}
                    value={draft.notes}
                    editable={!saving}
                    multiline
                    maxLength={KIN_WORK_NOTES_MAX}
                    onChangeText={(notes) => setDraft({ ...draft, notes })}
                    textAlignVertical="top"
                    placeholder={KIN_WORK_NEW_COPY.notesPlaceholder}
                    placeholderTextColorClassName="accent-placeholder"
                    className="min-h-24 font-sans text-base text-foreground"
                  />
                </View>
              </ListSection>
            </>
          )}
        </ScreenScrollView>
      </ScreenContent>
    </View>
  );
}
