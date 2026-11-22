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
  kinWorkDraftHolder,
  kinWorkDraftHint,
  kinWorkDraftWords,
  kinWorkTitleCount,
  kinWorkTitleTooLong,
  kinWorkHostClients,
  kinWorkPrincipalKey,
  type KinWorkAssignee,
  type KinWorkDraft,
} from "@t3tools/client-runtime/kin/kinWork";
import {
  KIN_TASK_WITH,
  kinTaskWith,
  kinTaskWithChoices,
  kinTaskWithout,
} from "@t3tools/client-runtime/kin/kinTaskRecord";
import {
  KIN_CLIENTS,
  KIN_SHORT_FORMS,
  kinNewTaskChoices,
  kinShortFormFold,
  kinTaskProjectsAllowed,
  kinWorkDraftAnother,
  type KinShortFormField,
} from "@t3tools/client-runtime/kin/kinWorkClients";
import { kinAccessMeAtom } from "@t3tools/client-runtime/kin/kinAccess";
import { kinFormTyped } from "@t3tools/client-runtime/kin/kinWorkForms";
import { EnvironmentId, KIN_WORK_ALSO_ON_MAX, KinOrgId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { type ComponentRef, useRef, useState } from "react";
import { TextInput, View } from "react-native";

import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Chip } from "../../components/ui/Chip";
import { EmptyState } from "../../components/ui/EmptyState";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { ListSection } from "../../components/ui/ListSection";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { uuidv4 } from "../../lib/uuid";
import { useAtomCommand } from "../../state/use-atom-command";
import { KinAvatar } from "./components/KinAvatar";
import { useKinTextGrows } from "./components/kinTextGrows";
import { KinDayField } from "./components/KinDayField";
import { KinPageFold } from "./components/KinPageFold";
import { KinWorkPlacePicker } from "./components/KinWorkPlacePicker";
import { KinWorkSideRow } from "./components/KinWorkTaskMenus";
import { kinWorkRefParam, type KinWorkParams } from "./state/kinWorkParams";
import { kinClient } from "./state/kinClient";
import {
  useKinWork,
  useKinWorkChoices,
  useKinWorkDirectory,
  type KinWorkTarget,
} from "./state/useKinWork";
import {
  KinGateView,
  KinWorkAboveKeyboard,
  KinWorkFieldBox,
  KinWorkTextField,
  useKinAskBeforeDiscard,
} from "./components/KinWorkPieces";
import { useKinGate } from "./state/useKinHost";

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeOrgId = Schema.decodeUnknownOption(KinOrgId);
const when = <T,>(on: boolean, field: T): ReadonlyArray<T> => (on ? [field] : []);

/** A short form: what, who and when, the rest under More. Longer is better said to a lead in chat. */
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
  // One id a task: trying again after a dropped answer never adds a second one.
  const [requestId, setRequestId] = useState(uuidv4);
  const [opened] = useState(() => new Date());
  const [draft, setDraft] = useState<KinWorkDraft>(props.start);
  // What the sheet holds before anything is typed: the start, or what "Add another" kept.
  const [base, setBase] = useState<KinWorkDraft>(props.start);
  const [added, setAdded] = useState<string | null>(null);
  const titleField = useRef<ComponentRef<typeof TextInput>>(null);
  const notesField = useRef<ComponentRef<typeof TextInput>>(null);
  const leave = useKinAskBeforeDiscard(kinFormTyped(base, draft));
  const work = useKinWork(target);
  // An older server has no clients or projects to put a task under.
  const hostClients = kinWorkHostClients(work._tag === "ready" ? work.live.summary : null);
  const me = useAtomValue(kinAccessMeAtom(connectionAtomRuntime, environmentId));
  const choices = kinNewTaskChoices(useKinWorkChoices(target, allowed && hostClients), me);
  const offersClient = choices.clients.length > 0 || draft.party !== null;
  const offersProject = choices.projects.length > 0 || draft.project !== null;
  const words = kinWorkDraftWords(draft);
  const titleCount = kinWorkTitleCount(draft.title);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const grows = useKinTextGrows();
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

  const fold = kinShortFormFold("task", {
    absent: [
      ...when(draft.due === null, "repeat" as const),
      ...when(!hostClients || !offersClient, "client" as const),
      ...when(!hostClients || !offersProject, "project" as const),
    ],
    held: [
      ...when(props.start.party !== null, "client" as const),
      ...when(props.start.project !== null, "project" as const),
    ],
  });

  const save = async (another: boolean) => {
    if (saving || !allowed) return;
    if (!checked.ok) return setProblem(checked.problem);
    setSaving(true);
    setProblem(null);
    const outcome = await actions.add(checked.input, requestId);
    setSaving(false);
    if (!outcome.ok) return setProblem(outcome.problem);
    if (another) {
      const next = kinWorkDraftAnother(draft);
      setDraft(next);
      setBase(next);
      setRequestId(uuidv4());
      setAdded(checked.input.title);
      return titleField.current?.focus();
    }
    leave();
    navigation.goBack();
  };

  const field = (name: KinShortFormField<"task">) => {
    switch (name) {
      case "title":
        return (
          <View key={name} className="gap-2">
            <ListSection>
              <KinWorkFieldBox label={words.titleLabel} input={titleField}>
                <TextInput
                  ref={titleField}
                  accessibilityLabel={words.titleLabel}
                  value={draft.title}
                  editable={!saving}
                  autoFocus
                  autoCapitalize="sentences"
                  returnKeyType="next"
                  submitBehavior="submit"
                  onSubmitEditing={() => {
                    if (draft.title.trim() !== "") void save(true);
                  }}
                  onChangeText={(title) => setDraft((held) => ({ ...held, title }))}
                  textAlignVertical="center"
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
              </KinWorkFieldBox>
            </ListSection>
            <View className="flex-row flex-wrap items-center gap-3 px-2">
              <Button
                tone="secondary"
                size="compact"
                icon="plus"
                label={KIN_SHORT_FORMS.addAnother}
                disabled={saving || draft.title.trim() === ""}
                onPress={() => void save(true)}
              />
              {added === null ? null : (
                <Text
                  textRole="footnote"
                  accessibilityLiveRegion="polite"
                  className="min-w-0 shrink text-foreground-muted"
                >
                  {KIN_SHORT_FORMS.added(added)}
                </Text>
              )}
            </View>
          </View>
        );
      case "owner":
        return (
          <View key={name} className="gap-2">
            <Text className="px-2 text-sm text-foreground-muted">
              {KIN_WORK_NEW_COPY.ownerLabel}
            </Text>
            <View className="flex-row flex-wrap gap-2">
              {everyone.map((to) => (
                <Chip
                  wrap={grows}
                  key={to.key}
                  leading={<KinAvatar avatar={to.avatar} size="mini" />}
                  label={to.invited ? `${to.name}, invited` : to.name}
                  selected={to.key === ownerKey}
                  disabled={saving || to.invited === true}
                  onPress={() =>
                    setDraft((held) => kinWorkDraftHolder(held, to.principal, names.me))
                  }
                />
              ))}
            </View>
            {hint === null ? null : (
              <Text textRole="footnote" className="px-2 text-foreground-muted">
                {hint}
              </Text>
            )}
            <KinWorkNewWith
              draft={draft}
              choices={kinTaskWithChoices(assignees, {
                owner: everyone.find((to) => to.key === ownerKey)?.principal ?? draft.owner,
              })}
              names={names}
              disabled={saving}
              onChange={setDraft}
            />
          </View>
        );
      case "due":
        return (
          <ListSection key={name}>
            <KinDayField
              label={KIN_WORK_NEW_COPY.dueLabel}
              day={draft.due}
              zone={names.zone}
              now={opened}
              disabled={saving}
              onPick={(due) =>
                setDraft((held) => ({
                  ...held,
                  due,
                  ...(due === null ? { repeat: null } : {}),
                }))
              }
            />
          </ListSection>
        );
      case "repeat":
        return (
          <View key={name} className="gap-2">
            <Text className="px-2 text-sm text-foreground-muted">{KIN_WORK_REPEAT.label}</Text>
            <View className="flex-row flex-wrap gap-2">
              <Chip
                wrap={grows}
                label={KIN_WORK_REPEAT.never}
                selected={draft.repeat === null}
                disabled={saving}
                onPress={() => setDraft((held) => ({ ...held, repeat: null }))}
              />
              {KIN_WORK_REPEAT.choices.map((choice) => (
                <Chip
                  wrap={grows}
                  key={choice.label}
                  label={choice.label}
                  selected={kinSameRepeat(choice.rule, draft.repeat)}
                  disabled={saving}
                  onPress={() => setDraft((held) => ({ ...held, repeat: choice.rule }))}
                />
              ))}
            </View>
            {draft.repeat === null ? null : (
              <Text textRole="footnote" className="px-2 text-foreground-muted">
                {KIN_WORK_REPEAT.note}
              </Text>
            )}
          </View>
        );
      case "client":
        return (
          <KinWorkAboveKeyboard key={name} value={aboveKeyboard}>
            <ListSection>
              <KinWorkPlacePicker
                target={target}
                noun="client"
                icon="person.2"
                label={KIN_WORK_NEW_COPY.clientLabel}
                held={draft.party}
                choices={choices.clients}
                disabled={saving}
                // A deal belongs to its client: another client leaves it.
                onPick={(party) => setDraft((held) => ({ ...held, party, deal: null }))}
              />
              {draft.party === null ? null : (
                <KinWorkSideRow
                  side={draft.side}
                  disabled={saving}
                  onPick={(side) => setDraft((held) => ({ ...held, side }))}
                />
              )}
              {draft.party === null || draft.side === null || draft.deal == null ? null : (
                <Text className="px-4 py-3 text-sm text-foreground-muted">
                  {`${KIN_WORK_NEW_COPY.dealLabel}: ${draft.deal.title}`}
                </Text>
              )}
              {draft.party === null || draft.side === null ? null : (
                <KinWorkTextField
                  label={KIN_WORK_NEW_COPY.fromLabel}
                  value={draft.from ?? ""}
                  disabled={saving}
                  maxLength={280}
                  onChangeText={(from) => setDraft((held) => ({ ...held, from }))}
                  placeholder={KIN_WORK_NEW_COPY.fromPlaceholder}
                />
              )}
            </ListSection>
          </KinWorkAboveKeyboard>
        );
      case "project":
        return (
          <KinWorkAboveKeyboard key={name} value={aboveKeyboard}>
            <ListSection>
              <KinWorkPlacePicker
                target={target}
                noun="project"
                icon="folder"
                label={KIN_WORK_NEW_COPY.projectLabel}
                held={draft.project}
                choices={choices.projects}
                only={kinTaskProjectsAllowed(me)}
                disabled={saving}
                onPick={(project) => setDraft((held) => ({ ...held, project }))}
              />
            </ListSection>
          </KinWorkAboveKeyboard>
        );
      case "notes":
        return (
          <ListSection key={name}>
            <KinWorkFieldBox label={KIN_WORK_NEW_COPY.notesLabel} input={notesField}>
              <TextInput
                ref={notesField}
                accessibilityLabel={KIN_WORK_NEW_COPY.notesLabel}
                value={draft.notes}
                editable={!saving}
                multiline
                maxLength={KIN_WORK_NOTES_MAX}
                onChangeText={(notes) => setDraft((held) => ({ ...held, notes }))}
                textAlignVertical="top"
                placeholder={KIN_WORK_NEW_COPY.notesPlaceholder}
                placeholderTextColorClassName="accent-placeholder"
                className="min-h-24 font-sans text-base text-foreground"
              />
            </KinWorkFieldBox>
          </ListSection>
        );
    }
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
          onPress: () => void save(false),
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
          // In this sheet React Native's own keyboard inset scrolls the focused title under the
          // bar on open; the fields further down lift themselves (`KinWorkAboveKeyboard`).
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 20 }}
        >
          {gate !== null ? (
            <KinGateView gate={gate} refused={kinWorkOnlyOwner("tasks")} label={words.title} />
          ) : (
            <>
              {problem === null ? null : <ErrorBanner message={problem} />}
              {fold.first.map(field)}
              {fold.moreLine === null ? null : (
                <KinPageFold title={KIN_SHORT_FORMS.more} summary={fold.moreLine}>
                  {fold.more.map(field)}
                </KinPageFold>
              )}
            </>
          )}
        </ScreenScrollView>
      </ScreenContent>
    </View>
  );
}

/** "+ With" under who has it: who else is on the new task, picked from the holder's own list. */
function KinWorkNewWith(props: {
  readonly draft: KinWorkDraft;
  readonly choices: ReturnType<typeof kinTaskWithChoices>;
  readonly names: Parameters<typeof kinTaskWith>[0]["names"];
  readonly disabled: boolean;
  readonly onChange: (draft: KinWorkDraft) => void;
}) {
  const { draft, choices } = props;
  const grows = useKinTextGrows();
  const [open, setOpen] = useState(false);
  const alsoOn = draft.alsoOn ?? [];
  const shown = kinTaskWith({ item: { alsoOn }, names: props.names, edit: true, change: true });
  const full = alsoOn.length >= KIN_WORK_ALSO_ON_MAX;
  const take = (row: KinWorkAssignee, on: boolean) =>
    props.onChange({
      ...draft,
      alsoOn: on ? kinTaskWithout({ alsoOn }, row.principal) : [...alsoOn, row.principal],
    });
  return (
    <View className="gap-2">
      <View className="flex-row flex-wrap gap-2">
        {open
          ? null
          : shown.people.map((who) => (
              <Chip
                wrap={grows}
                key={who.key}
                leading={<KinAvatar avatar={who.avatar} size="mini" />}
                label={who.name}
                selected
                trailingIcon="xmark"
                accessibilityLabel={KIN_TASK_WITH.remove(who.name)}
                disabled={props.disabled}
                onPress={() =>
                  props.onChange({ ...draft, alsoOn: kinTaskWithout({ alsoOn }, who.principal) })
                }
              />
            ))}
        <Chip
          icon={open ? "chevron.up" : "plus"}
          label={KIN_TASK_WITH.label}
          disabled={props.disabled}
          onPress={() => setOpen(!open)}
        />
      </View>
      {open ? (
        <View className="flex-row flex-wrap gap-2">
          {[...choices.people, ...choices.leads].map((row) => {
            const on = alsoOn.some((who) => kinWorkPrincipalKey(who) === row.key);
            return (
              <Chip
                wrap={grows}
                key={row.key}
                leading={<KinAvatar avatar={row.avatar} size="mini" />}
                label={row.invited ? `${row.name}, invited` : row.name}
                selected={on}
                disabled={props.disabled || row.invited === true || (full && !on)}
                onPress={() => take(row, on)}
              />
            );
          })}
        </View>
      ) : null}
      {open && full ? (
        <Text textRole="footnote" className="px-2 text-foreground-muted">
          {KIN_TASK_WITH.full}
        </Text>
      ) : null}
    </View>
  );
}
