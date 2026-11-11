import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  KIN_WORK_NEW_COPY,
  KIN_WORK_NOTES_MAX,
  KIN_WORK_ONLY_OWNER,
  KIN_WORK_TITLE_MAX,
  createKinWorkActions,
  kinWorkAssignees,
  kinWorkDraftCheck,
  kinWorkDraftFor,
  kinWorkDraftHint,
  kinWorkDraftWords,
  kinWorkHostClients,
  kinWorkDueChoices,
  kinWorkDueLabel,
  kinWorkPrincipalKey,
  type KinWorkDraft,
} from "@t3tools/client-runtime/kin/kinWork";
import { EnvironmentId, KinOrgId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useState } from "react";
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
import { KinWorkPlaceRow, KinWorkSideRow } from "./components/KinWorkTaskMenus";
import { kinWorkRefParam, type KinWorkParams } from "./KinWorkScreen";
import { kinClient } from "./state/kinClient";
import {
  useKinWork,
  useKinWorkChoices,
  useKinWorkDirectory,
  type KinWorkTarget,
} from "./state/useKinWork";

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeOrgId = Schema.decodeUnknownOption(KinOrgId);

/** "Friday, Fri, Nov 13"; "Today" needs no date said after it. */
function dueChoiceLabel(choice: { readonly label: string; readonly day: string }, now: Date) {
  const day = kinWorkDueLabel(choice.day, now);
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
        side: route.params.side === "theirs" ? "theirs" : "ours",
      })}
    />
  );
}

function KinWorkNewForm(props: KinWorkTarget & { readonly start: KinWorkDraft }) {
  const navigation = useNavigation();
  const { environmentId, orgId } = props;
  const target = { environmentId, orgId };
  const allowed = useAtomValue(kinClient.workCreate.permissionAtom(environmentId));
  const { orgs, people, names } = useKinWorkDirectory(target, allowed);
  const create = useAtomCommand(kinClient.workCreate, { reportFailure: false });
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
  const choices = useKinWorkChoices(target, allowed && hostClients);
  const words = kinWorkDraftWords(draft);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const assignees = kinWorkAssignees({ orgs, orgId, people, names, current: null });
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
        title={words.title}
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
          className="flex-1"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 20 }}
        >
          {!allowed ? (
            <EmptyState variant="plain" {...KIN_WORK_ONLY_OWNER} />
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
                    maxLength={KIN_WORK_TITLE_MAX}
                    onChangeText={(title) => setDraft({ ...draft, title })}
                    textAlignVertical="center"
                    placeholder={words.titlePlaceholder}
                    placeholderTextColorClassName="accent-placeholder"
                    className="min-h-8 font-sans text-base text-foreground"
                  />
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
                      label={to.name}
                      selected={to.key === ownerKey}
                      disabled={saving}
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
                    onPress={() => setDraft({ ...draft, due: null })}
                  />
                  {kinWorkDueChoices(opened).map((choice) => (
                    <Chip
                      key={choice.day}
                      label={choice.label}
                      accessibilityLabel={dueChoiceLabel(choice, opened)}
                      selected={draft.due === choice.day}
                      disabled={saving}
                      onPress={() => setDraft({ ...draft, due: choice.day })}
                    />
                  ))}
                </View>
              </View>
              {!hostClients ? null : (
                <ListSection>
                  <KinWorkPlaceRow
                    icon="person.2"
                    label={KIN_WORK_NEW_COPY.clientLabel}
                    none={KIN_WORK_NEW_COPY.none}
                    held={draft.party}
                    choices={choices.clients}
                    disabled={saving}
                    onPick={(party) => setDraft({ ...draft, party })}
                  />
                  {draft.party === null ? null : (
                    <KinWorkSideRow
                      side={draft.side}
                      disabled={saving}
                      onPick={(side) => setDraft({ ...draft, side })}
                    />
                  )}
                  <KinWorkPlaceRow
                    icon="folder"
                    label={KIN_WORK_NEW_COPY.projectLabel}
                    none={KIN_WORK_NEW_COPY.none}
                    held={draft.project}
                    choices={choices.projects}
                    disabled={saving}
                    onPick={(project) => setDraft({ ...draft, project })}
                  />
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
