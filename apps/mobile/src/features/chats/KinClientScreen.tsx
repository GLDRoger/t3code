import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  KIN_WORK_ONLY_OWNER,
  KIN_WORK_STALE,
  kinWorkHostEdits,
} from "@t3tools/client-runtime/kin/kinWork";
import { kinWorkApplied, type KinWorkAction } from "@t3tools/client-runtime/kin/kinWorkChanges";
import {
  KIN_CLIENTS,
  KIN_CLIENT_FAILED,
  KIN_CLIENT_GONE,
  KIN_PROJECTS,
  kinClientPageView,
  kinWorkTimeline,
  type KinContactView,
  type KinOwedView,
} from "@t3tools/client-runtime/kin/kinWorkClients";
import { kinWorkSend, type KinWorkFormProblem } from "@t3tools/client-runtime/kin/kinWorkForms";
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
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRow } from "../../components/ui/ListRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { Notice } from "../../components/ui/Notice";
import { useNowMinuteMs } from "../../lib/clock";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  KinWorkFrame,
  KinWorkLoading,
  KinWorkPrivateMark,
  KinWorkProblemNotice,
  KinWorkTaskRow,
  KinWorkTimelineLines,
} from "./components/KinWorkPieces";
import { KinWorkNamedRow } from "./KinWorkLists";
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
  if (environmentId === null || orgId === null || key === null) {
    return (
      <KinWorkFrame title={KIN_CLIENTS.title} onBack={() => navigation.goBack()}>
        <EmptyState
          variant="plain"
          title="This link doesn't name a client"
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
  const allowed = useAtomValue(kinClient.workRead.permissionAtom(props.environmentId));
  // A teammate who follows a link asks the host nothing.
  if (!allowed) {
    return (
      <KinWorkFrame title={KIN_CLIENTS.title} onBack={() => navigation.goBack()}>
        <EmptyState variant="plain" {...KIN_WORK_ONLY_OWNER} />
      </KinWorkFrame>
    );
  }
  return <KinClientStates {...props} />;
}

function KinClientStates(props: ClientTarget) {
  const navigation = useNavigation();
  const { state, refresh } = useKinClientPage(props, props.clientKey);
  if (state._tag === "ready") {
    return <KinClientBody {...props} page={state.value} stale={state.stale} onRefresh={refresh} />;
  }
  return (
    <KinWorkFrame title={KIN_CLIENTS.title} onBack={() => navigation.goBack()}>
      {state._tag === "loading" ? (
        <KinWorkLoading label="Loading client" />
      ) : state._tag === "gone" ? (
        <EmptyState variant="plain" {...KIN_CLIENT_GONE} />
      ) : state._tag === "refused" ? (
        <EmptyState variant="plain" {...KIN_WORK_ONLY_OWNER} />
      ) : (
        <EmptyState
          variant="plain"
          {...KIN_CLIENT_FAILED}
          action={<Button tone="secondary" label="Try again" onPress={refresh} />}
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
  const { environmentId, orgId, page } = props;
  const target = { environmentId, orgId };
  const work = useKinWork(target);
  const { names } = useKinWorkDirectory(target, true);
  const { state: changed, changes } = useKinWorkChanges(target);
  const canChange = useAtomValue(kinClient.workClientUpdate.permissionAtom(environmentId));
  const canAddTask = useAtomValue(kinClient.workCreate.permissionAtom(environmentId));
  const canChangeTasks =
    useAtomValue(kinClient.workUpdate.permissionAtom(environmentId)) &&
    kinWorkHostEdits(work._tag === "ready" ? work.live.summary : null);
  const update = useAtomCommand(kinClient.workClientUpdate, { reportFailure: false });
  const now = new Date(useNowMinuteMs());
  const [problem, setProblem] = useState<KinWorkFormProblem | null>(null);
  const [busy, setBusy] = useState(false);
  const [unopened, setUnopened] = useState<string | null>(null);
  const history = useKinWorkHistory(target, props.clientKey, page.seq);

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
  );
  const act = (key: KinRecordKey, action: KinWorkAction) => {
    const record = [...page.weOwe.records, ...page.theyOwe.records].find(
      (held) => held.key === key,
    );
    if (record !== undefined) void changes.run(kinWorkApplied(record, changed), action, names);
  };
  const change = async (input: { readonly active?: boolean; readonly sensitive?: boolean }) => {
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
            onPress={() =>
              navigation.navigate("KinWorkItem", { environmentId, orgId, task: row.key })
            }
            onAct={canChangeTasks ? (action) => act(row.key, action) : null}
          />
        ))
      )}
      {side.more === null ? null : (
        <ListActionRow
          label={side.more}
          onPress={() => navigation.navigate("KinWork", { environmentId, orgId, ...about })}
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
    </ListSection>
  );
  return (
    <KinWorkFrame
      title={view.vendor ? "Vendor" : "Client"}
      onBack={() => navigation.goBack()}
      refresh={{ accessibilityLabel: "Refresh", onPress: props.onRefresh }}
      {...(canChange
        ? {
            actions: [
              {
                accessibilityLabel: KIN_CLIENTS.edit,
                icon: "pencil" as const,
                disabled: busy,
                onPress: () =>
                  navigation.navigate("KinClientForm", { environmentId, orgId, party: view.key }),
              },
            ],
            menus: [
              {
                title: "More",
                icon: "ellipsis" as const,
                items: [
                  {
                    id: "close",
                    title: view.closed ? KIN_CLIENTS.reopen : KIN_CLIENTS.close,
                    disabled: busy,
                    onPress: () => void change({ active: view.closed }),
                  },
                ],
              },
            ],
          }
        : {})}
    >
      <View className="gap-1 px-2">
        <Text
          textRole="headline"
          accessibilityRole="header"
          className="font-t3-bold text-foreground"
        >
          {view.name}
        </Text>
        <Text textRole="footnote" className="text-foreground-muted">
          {view.line}
        </Text>
        {view.privacy.private ? <KinWorkPrivateMark /> : null}
      </View>
      {props.stale ? <Notice message={KIN_WORK_STALE} /> : null}
      {problem === null ? null : (
        <KinWorkProblemNotice problem={problem} onDismiss={() => setProblem(null)} />
      )}
      {owed(KIN_CLIENTS.weOwe, view.weOwe, KIN_CLIENTS.nothingOwed, {
        label: KIN_CLIENTS.addWeOwe,
        side: "ours",
      })}
      {owed(KIN_CLIENTS.theyOwe, view.theyOwe, KIN_CLIENTS.nothingOwing, {
        label: KIN_CLIENTS.addTheyOwe,
        side: "theirs",
      })}
      <ListSection title={KIN_CLIENTS.projects}>
        {view.projects.length === 0 ? (
          <ListRowLayout label={KIN_CLIENTS.noProjects} disabled />
        ) : (
          view.projects.map((row) => (
            <KinWorkNamedRow
              key={row.key}
              inset
              row={row}
              onPress={() =>
                navigation.navigate("KinProject", { environmentId, orgId, project: row.key })
              }
            />
          ))
        )}
        {canChange && !view.closed ? (
          <ListActionRow
            label={KIN_PROJECTS.add}
            onPress={() =>
              navigation.navigate("KinProjectForm", { environmentId, orgId, ...about })
            }
          />
        ) : null}
      </ListSection>
      <ListSection
        title={KIN_CLIENTS.contacts}
        {...(view.contacts.length === 0 ? {} : { footer: KIN_CLIENTS.detailsPrivate })}
      >
        {view.contacts.length === 0 ? (
          <ListRowLayout label={KIN_CLIENTS.noContacts} disabled />
        ) : (
          view.contacts.map((contact) => (
            <KinContactRows
              key={contact.key}
              contact={contact}
              onOpen={(href, what) => void open(href, what)}
              onEdit={
                canChange
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
        {canChange ? (
          <ListActionRow
            label={KIN_CLIENTS.addContact}
            onPress={() =>
              navigation.navigate("KinContactForm", { environmentId, orgId, party: view.key })
            }
          />
        ) : null}
      </ListSection>
      {unopened === null ? null : <Notice message={unopened} onDismiss={() => setUnopened(null)} />}
      <View className="gap-2 px-2">
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
      <View className="gap-2 px-2">
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
      <ListSection>
        <ListToggleRow
          icon="lock"
          label={KIN_CLIENTS.privateLabel}
          description={view.privacy.note}
          value={view.privacy.private}
          disabled={!canChange || busy || view.privacy.inherited}
          onValueChange={(sensitive) => void change({ sensitive })}
        />
      </ListSection>
      <View className="gap-2 px-2">
        <Text textRole="footnote" className="text-foreground-muted">
          {KIN_CLIENTS.history}
        </Text>
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
              label="Try again"
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
            onOpenTask={(task) =>
              navigation.navigate("KinWorkItem", { environmentId, orgId, task })
            }
          />
        )}
        {history.state.more ? (
          <View className="items-start">
            <Button
              tone="secondary"
              size="compact"
              label={history.state.moreFailed ? "Try again" : KIN_CLIENTS.earlier}
              loading={history.state.loadingMore}
              disabled={history.state.loadingMore}
              onPress={() => void history.list.loadMore()}
            />
          </View>
        ) : null}
      </View>
    </KinWorkFrame>
  );
}

/** Someone to reach: a tap on the address or number hands it to the phone's own apps. */
function KinContactRows(props: {
  readonly contact: KinContactView;
  readonly onOpen: (href: string, what: string) => void;
  readonly onEdit: (() => void) | null;
}) {
  const { contact, onEdit } = props;
  const { email, phone } = contact;
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
      {email === null ? null : email.href === null ? (
        <ListRowLayout icon="envelope" label={email.text} />
      ) : (
        <ListActionRow
          icon="envelope"
          label={email.text}
          onPress={() => props.onOpen(email.href ?? "", "send email")}
        />
      )}
      {phone === null ? null : phone.href === null ? (
        <ListRowLayout icon="phone" label={phone.text} />
      ) : (
        <ListActionRow
          icon="phone"
          label={phone.text}
          onPress={() => props.onOpen(phone.href ?? "", "make calls")}
        />
      )}
    </>
  );
}
