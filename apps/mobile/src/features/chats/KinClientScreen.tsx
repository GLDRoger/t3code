import { KIN_MARKETING } from "@t3tools/client-runtime/kin/kinMarketing";
import { KIN_RETRY, kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { kinWorkHostEdits } from "@t3tools/client-runtime/kin/kinWork";
import {
  KIN_WORK_COPY,
  kinWorkApplied,
  type KinWorkAction,
} from "@t3tools/client-runtime/kin/kinWorkChanges";
import {
  KIN_CLIENTS as KIN_CLIENTS_WORDS,
  KIN_CLIENT_FAILED,
  KIN_CLIENT_REFUSED,
  KIN_CLIENT_GONE,
  KIN_PROJECTS,
  kinClientPageView,
  kinWorkTimeline,
  type KinContactView,
  type KinOwedView,
  type KinTouchView,
} from "@t3tools/client-runtime/kin/kinWorkClients";
import { KIN_MONEY_FORMS } from "@t3tools/client-runtime/kin/kinMoneyForms";
import {
  KIN_WORK_FORM_COPY,
  kinWorkSend,
  type KinWorkFormProblem,
} from "@t3tools/client-runtime/kin/kinWorkForms";
import {
  EnvironmentId,
  KinOrgId,
  KinRecordKey,
  type KinPartyPage,
  type KinRecord,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useState } from "react";
import { Alert, View } from "react-native";

import { Chip } from "../../components/ui/Chip";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRow } from "../../components/ui/ListRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { Notice } from "../../components/ui/Notice";
import { useNowMinuteMs } from "../../lib/clock";
import { cn } from "../../lib/cn";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  KinFoldSection,
  KinWorkFrame,
  KinWorkLoading,
  KinWorkPrivateMark,
  KinWorkProblemNotice,
  KinWorkStaleNotice,
  KinWorkTaskRow,
  KinWorkTimelineLines,
  KinWorkToggleRow,
} from "./components/KinWorkPieces";
import { KinClientDeals } from "./KinDealsList";
import {
  useKinSectionNamed,
  useKinSectionOn,
  useKinSectionWords,
  useKinShell,
} from "./state/useKinShell";
import {
  kinSectionNamed,
  kinSectionNamedWords,
  kinSectionOffLine,
  kinSectionOn,
} from "@t3tools/client-runtime/kin/kinShell";
import { KinWorkNamedRow } from "./KinWorkLists";
import { KinAvatar } from "./components/KinAvatar";
import { kinLines, useKinTextGrows } from "./components/kinTextGrows";
import { useKinIsOwnerLevel } from "./state/kinChatOnly";
import { KinPlaceLists } from "./KinPlaceLists";
import { KinDocsUnder } from "./KinDocsList";
import { kinClient } from "./state/kinClient";
import { kinHostConnected } from "./state/useKinHost";
import {
  useKinClientPage,
  useKinWork,
  useKinWorkChanges,
  useKinWorkDirectory,
  useKinWorkHistory,
  type KinWorkTarget,
} from "./state/useKinWork";
import { KinAsideNote, KinAttentionSection } from "./KinAttention";
import { useKinOpenPlace } from "./state/kinHomeTab";
import { useKinWorkLink } from "./state/kinWorkLink";
import { KinWatchLine } from "./KinWatchLine";

export type KinClientParams = {
  readonly environmentId: string;
  readonly orgId: string;
  /** The client's short handle, such as `C-3`. */
  readonly party: string;
};

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeOrgId = Schema.decodeUnknownOption(KinOrgId);
const decodeKey = Schema.decodeUnknownOption(KinRecordKey);

/** One client or vendor: what is owed each way, who to reach, and how it got here. */
export function KinClientScreen({ route }: StaticScreenProps<KinClientParams>) {
  const navigation = useNavigation();
  const environmentId = Option.getOrNull(decodeEnvironmentId(route.params.environmentId));
  const orgId = Option.getOrNull(decodeOrgId(route.params.orgId));
  const key = Option.getOrNull(decodeKey(route.params.party));
  const KIN_CLIENTS = useKinSectionWords(environmentId, KIN_CLIENTS_WORDS);
  const named = useKinSectionNamed(environmentId);
  if (environmentId === null || orgId === null || key === null) {
    return (
      <KinWorkFrame title={KIN_CLIENTS.title} onBack={() => navigation.goBack()}>
        <EmptyState
          variant="plain"
          title={named("This link doesn't name a client")}
          detail="Open Work from your Kin chats."
        />
      </KinWorkFrame>
    );
  }
  return <KinClientGate key={key} environmentId={environmentId} orgId={orgId} clientKey={key} />;
}

type ClientTarget = KinWorkTarget & { readonly clientKey: KinRecordKey };

function KinClientGate(props: ClientTarget) {
  const navigation = useNavigation();
  const KIN_CLIENTS = useKinSectionWords(props.environmentId, KIN_CLIENTS_WORDS);
  const shell = useKinShell(props.environmentId);
  const allowed = useAtomValue(kinClient.workRead.permissionAtom(props.environmentId));
  // A teammate who follows a link asks the host nothing.
  if (!allowed) {
    return (
      <KinWorkFrame title={KIN_CLIENTS.title} onBack={() => navigation.goBack()}>
        <EmptyState variant="plain" {...kinSectionNamedWords(shell, KIN_CLIENT_REFUSED)} />
      </KinWorkFrame>
    );
  }
  return <KinClientStates {...props} />;
}

function KinClientStates(props: ClientTarget) {
  const navigation = useNavigation();
  const KIN_CLIENTS = useKinSectionWords(props.environmentId, KIN_CLIENTS_WORDS);
  const shell = useKinShell(props.environmentId);
  const { state, refresh } = useKinClientPage(props, props.clientKey);
  if (state._tag === "ready") {
    return <KinClientBody {...props} page={state.value} stale={state.stale} onRefresh={refresh} />;
  }
  return (
    <KinWorkFrame title={KIN_CLIENTS.title} onBack={() => navigation.goBack()}>
      {state._tag === "loading" ? (
        <KinWorkLoading label={kinSectionNamed(shell, "Loading client")} />
      ) : state._tag === "gone" ? (
        <EmptyState variant="plain" {...kinSectionNamedWords(shell, KIN_CLIENT_GONE)} />
      ) : state._tag === "refused" ? (
        <EmptyState variant="plain" {...kinSectionNamedWords(shell, KIN_CLIENT_REFUSED)} />
      ) : (
        <EmptyState
          variant="plain"
          {...kinSectionNamedWords(shell, KIN_CLIENT_FAILED)}
          action={<Button tone="secondary" label={KIN_RETRY} onPress={refresh} />}
        />
      )}
    </KinWorkFrame>
  );
}

function KinClientBody(
  props: ClientTarget & {
    readonly page: KinPartyPage;
    readonly stale: boolean;
    readonly onRefresh: () => void;
  },
) {
  const navigation = useNavigation();
  const openRecord = useKinWorkLink();
  const { environmentId, orgId, page } = props;
  const target = { environmentId, orgId };
  const openPlace = useKinOpenPlace(target);
  const work = useKinWork(target);
  const directory = useKinWorkDirectory(target, true);
  const { names } = directory;
  const { state: changed, changes } = useKinWorkChanges(target);
  const ownerLevel = useKinIsOwnerLevel(environmentId);
  const canAddTask = useAtomValue(kinClient.workCreate.permissionAtom(environmentId));
  const KIN_CLIENTS = useKinSectionWords(environmentId, KIN_CLIENTS_WORDS);
  const shell = useKinShell(environmentId);
  // A client opened by its link while Clients is off says so; Invoices off takes its invoicing.
  const offLine = kinSectionOffLine(shell, "clients", ownerLevel);
  const canInvoice =
    useAtomValue(kinClient.workNewInvoice.permissionAtom(environmentId)) &&
    kinSectionOn(shell, "invoices");
  const dealsOn = useKinSectionOn(environmentId, "deals");
  const canChangeTasks =
    useAtomValue(kinClient.workUpdate.permissionAtom(environmentId)) &&
    kinWorkHostEdits(work._tag === "ready" ? work.live.summary : null);
  const update = useAtomCommand(kinClient.workClientUpdate, { reportFailure: false });
  const now = new Date(useNowMinuteMs());
  const [problem, setProblem] = useState<KinWorkFormProblem | null>(null);
  const [busy, setBusy] = useState(false);
  const [unopened, setUnopened] = useState<string | null>(null);
  const history = useKinWorkHistory(target, props.clientKey, page.seq);
  const removeTouch = useAtomCommand(kinClient.workTouchRemove, { reportFailure: false });
  const [refused, setRefused] = useState<string | null>(null);
  const grows = useKinTextGrows();
  // A logged contact taken back, after a plain confirm; what Kin read from its records stays.
  const askRemoveTouch = (touch: KinTouchView) =>
    Alert.alert(KIN_CLIENTS.touchRemoveTitle, `${touch.title}, ${touch.when}`, [
      { text: "Cancel", style: "cancel" },
      {
        text: KIN_CLIENTS.touchRemove,
        style: "destructive",
        // A teammate removes only what they logged; the host says so for anyone else's.
        onPress: () =>
          void removeTouch({ environmentId, input: { orgId, touchId: touch.id } }).then(
            (result) => {
              setRefused(
                result._tag === "Success"
                  ? null
                  : kinFailureText(squashAtomCommandFailure(result), KIN_CLIENTS.touchFailed),
              );
              props.onRefresh();
            },
          ),
      },
    ]);

  const applied = (records: ReadonlyArray<KinRecord>) =>
    records.map((record) => kinWorkApplied(record, changed));
  const view = kinClientPageView(
    {
      ...page,
      weOwe: { ...page.weOwe, records: applied(page.weOwe.records) },
      theyOwe: { ...page.theyOwe, records: applied(page.theyOwe.records) },
    },
    names,
    now,
    ownerLevel,
  );
  const { can } = view;
  // Clients on, or the owner level: what's owed, the contact log, notes and history show.
  const full = can.log;
  const keepsContacts = can.contacts ?? can.edit;
  const act = (key: KinRecordKey, action: KinWorkAction) => {
    const record = [...page.weOwe.records, ...page.theyOwe.records].find(
      (held) => held.key === key,
    );
    if (record !== undefined) void changes.run(kinWorkApplied(record, changed), action, names);
  };
  const change = async (input: {
    readonly active?: boolean;
    readonly sensitive?: boolean;
    readonly prospect?: boolean;
  }) => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const outcome = await kinWorkSend({
      online: () => kinHostConnected(environmentId),
      send: () =>
        update({ environmentId, input: { orgId, key: view.key, rev: view.rev, ...input } }),
      noun: "client",
      name: view.name,
      own: view.key,
    });
    setBusy(false);
    if (outcome.ok) props.onRefresh();
    else {
      setProblem(outcome.problem);
      if (outcome.problem.kind === "conflict") props.onRefresh();
    }
  };
  const open = async (href: string, what: string) => {
    setUnopened(null);
    if (!(await tryOpenExternalUrl(href, "markdown-link")))
      setUnopened(`This phone has nothing set up to ${what}.`);
  };
  const about = { party: view.key, partyName: view.name };
  const owed = (
    title: string,
    side: KinOwedView,
    empty: string,
    add: { readonly label: string; readonly side: "ours" | "theirs" },
    also?: { readonly label: string; readonly side: "ours" | "theirs" },
  ) => (
    <ListSection title={side.total === 0 ? title : `${title} · ${side.total}`}>
      {side.rows.length === 0 ? (
        <ListRowLayout label={empty} disabled />
      ) : (
        side.rows.map((row) => (
          <KinWorkTaskRow
            key={row.key}
            inset
            row={row}
            saving={changed.pending[row.key] !== undefined}
            onPress={() => openRecord("KinWorkItem", { environmentId, orgId, task: row.key })}
            onAct={canChangeTasks ? (action) => act(row.key, action) : null}
          />
        ))
      )}
      {side.more === null ? null : (
        <ListActionRow
          label={side.more}
          onPress={() =>
            openPlace("tasks", { party: { key: view.key, title: view.name }, project: null })
          }
        />
      )}
      {canAddTask && !view.closed ? (
        <ListActionRow
          label={add.label}
          onPress={() =>
            navigation.navigate("KinWorkNew", { environmentId, orgId, ...about, side: add.side })
          }
        />
      ) : null}
      {also !== undefined && canAddTask && !view.closed ? (
        <ListActionRow
          label={also.label}
          onPress={() =>
            navigation.navigate("KinWorkNew", { environmentId, orgId, ...about, side: also.side })
          }
        />
      ) : null}
    </ListSection>
  );
  const waitingNone = view.theyOwe.total === 0 && view.theyOwe.rows.length === 0;
  const contactsFooter = [
    view.contacts.length === 0 || !full ? null : KIN_CLIENTS.detailsPrivate,
    view.contactsWho,
  ]
    .filter((line) => line !== null)
    .join(" ");
  return (
    <KinWorkFrame
      title={
        view.vendor
          ? KIN_CLIENTS.kindVendor
          : view.prospect
            ? KIN_CLIENTS.kindProspect
            : KIN_CLIENTS.kindClient
      }
      onBack={() => navigation.goBack()}
      refresh={{ accessibilityLabel: "Refresh", onPress: props.onRefresh }}
      {...(can.edit || can.owner || canInvoice
        ? {
            actions: can.edit
              ? [
                  {
                    accessibilityLabel: KIN_CLIENTS.edit,
                    icon: "pencil" as const,
                    disabled: busy,
                    onPress: () =>
                      navigation.navigate("KinClientForm", {
                        environmentId,
                        orgId,
                        party: view.key,
                      }),
                  },
                ]
              : [],
            menus: [
              {
                title: "More",
                icon: "ellipsis" as const,
                items: [
                  ...(canInvoice && !view.vendor && !view.closed
                    ? [
                        {
                          id: "invoice",
                          title: KIN_MONEY_FORMS.invoice.title,
                          disabled: busy,
                          onPress: () =>
                            navigation.navigate("KinInvoiceNew", {
                              environmentId,
                              orgId,
                              party: view.key,
                              partyName: view.name,
                            }),
                        },
                      ]
                    : []),
                  ...(can.edit && !view.vendor
                    ? [
                        {
                          id: "kind",
                          title: view.prospect ? KIN_CLIENTS.makeClient : KIN_CLIENTS.makeProspect,
                          disabled: busy,
                          onPress: () => void change({ prospect: !view.prospect }),
                        },
                      ]
                    : []),
                  ...(can.owner
                    ? [
                        {
                          id: "close",
                          title: view.closed ? KIN_CLIENTS.reopen : KIN_CLIENTS.close,
                          disabled: busy,
                          onPress: () =>
                            view.closed
                              ? void change({ active: true })
                              : Alert.alert(
                                  KIN_CLIENTS.closeAsk(view.name),
                                  KIN_CLIENTS.closeDetail,
                                  [
                                    { text: KIN_WORK_COPY.cancel, style: "cancel" },
                                    {
                                      text: KIN_CLIENTS.close,
                                      style: "destructive",
                                      onPress: () => void change({ active: false }),
                                    },
                                  ],
                                ),
                        },
                      ]
                    : []),
                ],
              },
            ],
          }
        : {})}
    >
      {offLine === null ? null : (
        <Text textRole="footnote" className="px-2 text-foreground-muted">
          {offLine}
        </Text>
      )}
      <View className="gap-1 px-2">
        <Text
          textRole="headline"
          accessibilityRole="header"
          className="font-t3-bold text-foreground"
        >
          {view.name}
        </Text>
        <Text
          textRole="footnote"
          className={view.prospect ? "font-t3-medium text-primary-text" : "text-foreground-muted"}
        >
          {view.line}
        </Text>
        <View className={cn("flex-row items-center gap-1.5", grows && "flex-wrap")}>
          <Text textRole="footnote" className="text-foreground-muted">
            {KIN_CLIENTS.lookedAfterBy}
          </Text>
          <KinAvatar avatar={view.lookedAfter.avatar} size="mini" />
          <Text
            textRole="footnote"
            numberOfLines={kinLines(1, grows)}
            className="shrink text-foreground"
          >
            {view.lookedAfter.name}
          </Text>
        </View>
        {view.privacy.private ? <KinWorkPrivateMark /> : null}
      </View>
      {props.stale ? (
        <KinWorkStaleNotice environmentId={environmentId} onRetry={props.onRefresh} />
      ) : null}
      {problem === null ? null : (
        <KinWorkProblemNotice problem={problem} onDismiss={() => setProblem(null)} />
      )}
      <KinAsideNote {...target} record={view.key} names={names} />
      <KinWatchLine {...target} recordKey={view.key} />
      <KinAttentionSection
        {...target}
        scope={{ type: "client", key: view.key }}
        names={names}
        onOpen={(to) => {
          if (to.type === "record")
            openRecord("KinWorkItem", { environmentId, orgId, task: to.key });
        }}
      />
      {view.nextStep === null || !full ? null : (
        <ListSection title={KIN_CLIENTS.nextStep}>
          {view.nextStep.next === null ? (
            <>
              <ListRowLayout label={KIN_CLIENTS.noNextStep} disabled />
              {canAddTask && !view.closed ? (
                <ListActionRow
                  label={KIN_CLIENTS.addNextStep}
                  onPress={() =>
                    navigation.navigate("KinWorkNew", {
                      environmentId,
                      orgId,
                      ...about,
                      side: "ours",
                    })
                  }
                />
              ) : null}
            </>
          ) : (
            <ListRow
              label={view.nextStep.next.title}
              description={view.nextStep.next.line}
              onPress={() => {
                const next = view.nextStep?.next;
                if (next != null)
                  openRecord("KinWorkItem", { environmentId, orgId, task: next.key });
              }}
            />
          )}
        </ListSection>
      )}
      {/* Tax, terms, Keep private and closing stay the owner level's. */}
      {!full
        ? null
        : owed(
            KIN_CLIENTS.weOwe,
            view.weOwe,
            KIN_CLIENTS.nothingOwed,
            { label: KIN_CLIENTS.addWeOwe, side: "ours" },
            // With nothing waiting on them, that section is absent and its add sits here.
            waitingNone ? { label: KIN_CLIENTS.addTheyOwe, side: "theirs" } : undefined,
          )}
      {waitingNone || !full
        ? null
        : owed(KIN_CLIENTS.theyOwe, view.theyOwe, KIN_CLIENTS.nothingOwing, {
            label: KIN_CLIENTS.addTheyOwe,
            side: "theirs",
          })}
      {!full && view.projects.length === 0 ? null : (
        <ListSection title={KIN_CLIENTS.projects}>
          {view.projects.length === 0 ? (
            <ListRowLayout label={KIN_CLIENTS.noProjects} disabled />
          ) : (
            view.projects.map((row) => (
              <KinWorkNamedRow
                key={row.key}
                inset
                row={row}
                onPress={() => openRecord("KinProject", { environmentId, orgId, project: row.key })}
              />
            ))
          )}
          {can.owner && !view.closed ? (
            <ListActionRow
              label={KIN_PROJECTS.add}
              onPress={() =>
                navigation.navigate("KinProjectForm", { environmentId, orgId, ...about })
              }
            />
          ) : null}
        </ListSection>
      )}
      {view.vendor || !dealsOn ? null : (
        <KinClientDeals
          {...target}
          party={{ key: view.key, title: view.name }}
          closed={view.closed}
          names={names}
        />
      )}
      <ListSection
        title={KIN_CLIENTS.contacts}
        {...(contactsFooter === "" ? {} : { footer: contactsFooter })}
      >
        {view.contacts.length === 0 ? (
          <ListRowLayout
            label={keepsContacts ? KIN_CLIENTS.noContacts : KIN_CLIENTS.noContactsYet}
            disabled
          />
        ) : (
          view.contacts.map((contact) => (
            <KinContactRows
              key={contact.key}
              contact={contact}
              onOpen={(href, what) => void open(href, what)}
              onTag={(tag) =>
                navigation.navigate("KinMarketingList", { environmentId, orgId, title: tag, tag })
              }
              onEdit={
                keepsContacts
                  ? () =>
                      navigation.navigate("KinContactForm", {
                        environmentId,
                        orgId,
                        party: view.key,
                        contact: contact.key,
                      })
                  : null
              }
            />
          ))
        )}
        {keepsContacts ? (
          <ListActionRow
            label={KIN_CLIENTS.addContact}
            onPress={() =>
              navigation.navigate("KinContactForm", { environmentId, orgId, party: view.key })
            }
          />
        ) : null}
      </ListSection>
      <KinPlaceLists
        environmentId={environmentId}
        orgId={orgId}
        place={{ party: { key: view.key, title: view.name } }}
        seq={props.stale ? null : page.seq}
        directory={directory}
      />
      {unopened === null ? null : <Notice message={unopened} onDismiss={() => setUnopened(null)} />}
      {refused === null ? null : <Notice message={refused} onDismiss={() => setRefused(null)} />}
      <KinDocsUnder {...target} names={names} under={{ party: props.clientKey }} />
      <View className="gap-2">
        {view.touches === null || !full ? null : (
          <KinFoldSection title={KIN_CLIENTS.recentContact} summary={view.lastContact}>
            {view.touches.length === 0 ? (
              <ListRowLayout label={KIN_CLIENTS.noTouches} disabled />
            ) : (
              view.touches.map((touch) =>
                touch.removable ? (
                  <ListRow
                    key={touch.id}
                    label={touch.title}
                    {...(touch.note === null ? {} : { description: touch.note })}
                    detail={touch.when}
                    onPress={() => askRemoveTouch(touch)}
                  />
                ) : (
                  <ListRowLayout
                    key={touch.id}
                    label={touch.title}
                    {...(touch.note === null ? {} : { description: touch.note })}
                    detail={touch.when}
                    disabled
                  />
                ),
              )
            )}
            {!view.closed ? (
              <ListActionRow
                label={KIN_CLIENTS.logContact}
                onPress={() =>
                  navigation.navigate("KinTouchForm", { environmentId, orgId, party: view.key })
                }
              />
            ) : null}
          </KinFoldSection>
        )}
        {!full && view.address === null ? null : (
          <KinFoldSection
            title={KIN_CLIENTS.details}
            summary={can.owner ? KIN_CLIENTS.detailsSummary : null}
          >
            <View className="gap-3 bg-grouped-card px-4 py-3">
              {!full || view.source === null ? null : (
                <View className="gap-1">
                  <Text textRole="footnote" className="text-foreground-muted">
                    {KIN_CLIENTS.cameFrom}
                  </Text>
                  <Text textRole="body" selectable className="text-foreground">
                    {view.source}
                  </Text>
                </View>
              )}
              {!full || view.tags.length === 0 ? null : (
                <View className="gap-1">
                  <Text textRole="footnote" className="text-foreground-muted">
                    {KIN_CLIENTS.tags}
                  </Text>
                  <Text textRole="body" selectable className="text-foreground">
                    {view.tags.join(", ")}
                  </Text>
                </View>
              )}
              {view.address === null ? null : (
                <View className="gap-1">
                  <Text textRole="footnote" className="text-foreground-muted">
                    {KIN_WORK_FORM_COPY.party.address}
                  </Text>
                  <Text textRole="body" selectable className="text-foreground">
                    {view.address}
                  </Text>
                </View>
              )}
              {!can.owner ? null : (
                <>
                  {view.vendor && view.tax === null ? null : (
                    <View className="gap-1">
                      <Text textRole="footnote" className="text-foreground-muted">
                        {KIN_CLIENTS.tax}
                      </Text>
                      <Text
                        textRole="body"
                        selectable
                        className={view.tax === null ? "text-foreground-muted" : "text-foreground"}
                      >
                        {view.tax ?? KIN_CLIENTS.noTax}
                      </Text>
                    </View>
                  )}
                  <View className="gap-1">
                    <View className="flex-row items-center justify-between">
                      <Text textRole="footnote" className="text-foreground-muted">
                        {KIN_CLIENTS.terms}
                      </Text>
                      <KinWorkPrivateMark />
                    </View>
                    <Text
                      textRole="body"
                      selectable
                      className={view.terms === null ? "text-foreground-muted" : "text-foreground"}
                    >
                      {view.terms ?? KIN_CLIENTS.noTerms}
                    </Text>
                    <Text textRole="footnote" className="text-foreground-muted">
                      {KIN_CLIENTS.termsPrivate}
                    </Text>
                  </View>
                </>
              )}
              {!full ? null : (
                <View className="gap-1">
                  <Text textRole="footnote" className="text-foreground-muted">
                    {KIN_CLIENTS.notes}
                  </Text>
                  <Text
                    textRole="body"
                    selectable
                    className={view.notes === null ? "text-foreground-muted" : "text-foreground"}
                  >
                    {view.notes ?? KIN_CLIENTS.noNotes}
                  </Text>
                </View>
              )}
            </View>
            {can.owner ? (
              <KinWorkToggleRow
                icon="lock"
                label={KIN_CLIENTS.privateLabel}
                description={view.privacy.note}
                value={view.privacy.private}
                disabled={busy || view.privacy.inherited}
                onValueChange={(sensitive) => void change({ sensitive })}
              />
            ) : null}
          </KinFoldSection>
        )}
        {!full ? null : (
          <KinFoldSection title={KIN_CLIENTS.history} summary={null}>
            <View className="gap-2 bg-grouped-card px-4 py-3">
              {history.state.loading ? (
                <KinWorkLoading label="Loading history" />
              ) : history.state.failed !== null ? (
                <View className="items-start gap-2">
                  <Text textRole="footnote" className="text-foreground-muted">
                    Couldn't load the history.
                  </Text>
                  <Button
                    tone="secondary"
                    size="compact"
                    label={KIN_RETRY}
                    onPress={history.list.refresh}
                  />
                </View>
              ) : history.state.records.length === 0 ? (
                <Text textRole="footnote" className="text-foreground-muted">
                  {KIN_CLIENTS.noHistory}
                </Text>
              ) : (
                <KinWorkTimelineLines
                  lines={kinWorkTimeline(history.state.records, names, now, view.key)}
                  onOpenTask={(task) => openRecord("KinWorkItem", { environmentId, orgId, task })}
                />
              )}
              {history.state.more ? (
                <View className="items-start">
                  <Button
                    tone="secondary"
                    size="compact"
                    label={history.state.moreFailed ? KIN_RETRY : KIN_CLIENTS.earlier}
                    loading={history.state.loadingMore}
                    disabled={history.state.loadingMore}
                    onPress={() => void history.list.loadMore()}
                  />
                </View>
              ) : null}
            </View>
          </KinFoldSection>
        )}
      </View>
    </KinWorkFrame>
  );
}

/** Someone to reach: a tap on the address or number hands it to the phone's own apps. */
function KinContactRows(props: {
  readonly contact: KinContactView;
  readonly onOpen: (href: string, what: string) => void;
  readonly onTag: (tag: string) => void;
  readonly onEdit: (() => void) | null;
}) {
  const { contact, onEdit } = props;
  const reach = (
    icon: "envelope" | "phone",
    one: KinContactView["emails"][number],
    at: number,
    what: string,
  ) =>
    one.href === null ? (
      <ListRowLayout key={`${icon}-${at}`} icon={icon} label={one.text} />
    ) : (
      <ListActionRow
        key={`${icon}-${at}`}
        icon={icon}
        label={one.text}
        onPress={() => props.onOpen(one.href ?? "", what)}
      />
    );
  const who = {
    icon: "person.crop.circle" as const,
    label: contact.name,
    ...(contact.role === null && !contact.closed
      ? {}
      : {
          description: [contact.role, contact.closed ? "No longer a contact" : null]
            .filter((part) => part !== null)
            .join(" · "),
        }),
    ...(contact.notes === null ? {} : { detail: contact.notes }),
  };
  return (
    <>
      {onEdit === null ? <ListRowLayout {...who} /> : <ListRow {...who} onPress={onEdit} />}
      {contact.emails.map((one, at) => reach("envelope", one, at, "send email"))}
      {contact.phones.map((one, at) => reach("phone", one, at, "make calls"))}
      {contact.tags.length === 0 ? null : (
        <View
          className="flex-row flex-wrap gap-2 px-4 py-2"
          accessibilityLabel={KIN_MARKETING.tags}
        >
          {contact.tags.map((tag) => (
            <Chip key={tag} label={tag} size="small" icon="tag" onPress={() => props.onTag(tag)} />
          ))}
        </View>
      )}
    </>
  );
}
