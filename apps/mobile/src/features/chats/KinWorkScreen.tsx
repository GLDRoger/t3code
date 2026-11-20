import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  KIN_WORK_DEFAULT_FILTER,
  KIN_WORK_LOAD_FAILED,
  KIN_WORK_TITLE,
  kinWorkEntrySummary,
  kinWorkHostClients,
  kinWorkOffline,
  kinWorkOnlyOwner,
  type KinWorkRef,
} from "@t3tools/client-runtime/kin/kinWork";
import { KIN_CLIENTS_OLDER_HOST } from "@t3tools/client-runtime/kin/kinWorkClients";
import {
  KIN_WORK_HOME,
  kinClientsLine,
  kinDocsLine,
  kinMoneyLine,
  kinWorkPlaceParam,
  type KinWorkPlace,
} from "@t3tools/client-runtime/kin/kinWorkHome";
import type { KinWorkLive } from "@t3tools/client-runtime/kin/kinWorkStream";
import { EnvironmentId, KinOrgId, KinPersonId, KinRecordKey } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppBar } from "../../components/ui/AppBar";
import type { AppSymbolName } from "../../components/ui/AppSymbol";
import { EmptyState } from "../../components/ui/EmptyState";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { appAtomRegistry } from "../../state/atom-registry";
import { KinDocsList } from "./KinDocsList";
import { KinTasksList } from "./KinTasksList";
import { KinClientsList } from "./KinWorkLists";
import { KinMoneyArea } from "./KinWorkMoney";
import { KinListBanner } from "./components/KinListBanner";
import { KinLoadFailed } from "./components/KinLoadFailed";
import { useKinTab, kinTabFoot } from "./components/KinTab";
import { useKinViewerScope } from "./state/kinChatOnly";
import { retryKinAccess } from "./state/kinClient";
import { useKinOpenPlace } from "./state/kinHomeTab";
import { useKinMoneySummary } from "./state/useKinMoney";
import {
  kinWorkLiveAtom,
  useKinWork,
  useKinWorkChoices,
  useKinWorkDirectory,
  type KinWorkTarget,
} from "./state/useKinWork";
import { useKinClientCounts, useKinDocsRecent } from "./state/useKinWorkHome";

export type KinWorkParams = {
  readonly environmentId: string;
  readonly orgId: string;
  /** The place that opens: `tasks`, `clients`, `projects`, `docs` or `money`; Tasks otherwise. */
  readonly show?: string;
  /** The client the tasks start narrowed to, or a new task starts under. */
  readonly party?: string;
  readonly partyName?: string;
  readonly project?: string;
  readonly projectName?: string;
  /** `theirs` when a new task is something the client owes. */
  readonly side?: string;
  /** Tasks starts narrowed to what this person holds, from their page's "See all in Tasks". */
  readonly person?: string;
};

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeOrgId = Schema.decodeUnknownOption(KinOrgId);
const decodeKey = Schema.decodeUnknownOption(KinRecordKey);
const decodePerson = Schema.decodeUnknownOption(KinPersonId);

/** A client or project named in a link: its handle, and the name to show until it is read. */
export function kinWorkRefParam(key: string | undefined, title: string | undefined) {
  const held = Option.getOrNull(decodeKey(key));
  return held === null ? null : { key: held, title: title ?? held };
}

/**
 * The ways in from the chat list over coding threads, where there is no dock: one row per place,
 * each saying what is in it. A place the host keeps from this viewer has no row.
 */
export function KinWorkEntry(target: KinWorkTarget) {
  const state = useKinWork(target);
  // A teammate, or a host that couldn't be read: no way in rather than a dead one.
  if (state._tag === "refused" || state._tag === "failed") return null;
  return <KinPlaceEntries {...target} live={state._tag === "ready" ? state.live : null} />;
}

function KinPlaceEntries(props: KinWorkTarget & { readonly live: KinWorkLive | null }) {
  const open = useKinOpenPlace(props);
  const summary = props.live?.summary ?? null;
  const hostClients = kinWorkHostClients(summary);
  const money = useKinMoneySummary(props, { enabled: true }).state;
  const docs = useKinDocsRecent(props);
  const counts = useKinClientCounts(props, hostClients);
  const scope = useKinViewerScope(props.environmentId);
  return (
    <>
      <KinWorkEntryRow summary={kinWorkEntrySummary(summary)} onPress={() => open("tasks")} />
      {money._tag === "refused" || money._tag === "failed" ? null : (
        <KinPlaceEntryRow
          place="money"
          summary={money._tag === "ready" ? kinMoneyLine(money.value, scope) : null}
          onPress={() => open("money")}
        />
      )}
      {!hostClients ? null : (
        <KinPlaceEntryRow
          place="clients"
          summary={counts === null ? null : kinClientsLine(counts.clients, counts.projects)}
          onPress={() => open("clients")}
        />
      )}
      {docs.refused ? null : (
        <KinPlaceEntryRow
          place="docs"
          summary={docs.docs === null ? null : kinDocsLine(docs.docs.total, docs.docs.changed)}
          onPress={() => open("docs")}
        />
      )}
    </>
  );
}

export const KIN_PLACE_SYMBOL = {
  tasks: "checkmark.circle",
  money: "banknote",
  clients: "person.2",
  docs: "doc.text",
} as const satisfies Record<KinWorkPlace, AppSymbolName>;

function KinPlaceEntryRow(props: {
  readonly place: KinWorkPlace;
  readonly summary: string | null;
  readonly onPress: () => void;
}) {
  const title = KIN_WORK_HOME.places[props.place];
  const summary = props.summary ?? "…";
  return (
    <>
      <KinListBanner
        title={title}
        summary={summary}
        symbol={KIN_PLACE_SYMBOL[props.place]}
        accessibilityLabel={`${title}. ${summary}`}
        accessibilityHint={`Opens ${title}`}
        onPress={props.onPress}
      />
      <View className="ml-5 h-px bg-border-subtle" />
    </>
  );
}

/** Also drawn from fixtures in the component catalog. */
export function KinWorkEntryRow(props: { readonly summary: string; readonly onPress: () => void }) {
  return (
    <>
      <KinListBanner
        title={KIN_WORK_HOME.places.tasks}
        summary={props.summary}
        symbol={KIN_PLACE_SYMBOL.tasks}
        accessibilityLabel={`${KIN_WORK_HOME.places.tasks}. ${props.summary}`}
        accessibilityHint="Opens what is open and who has it"
        onPress={props.onPress}
      />
      <View className="ml-5 h-px bg-border-subtle" />
    </>
  );
}

/** A place of Work as a page, from a link or over coding threads. */
export function KinWorkScreen({ route }: StaticScreenProps<KinWorkParams>) {
  const environmentId = Option.getOrNull(decodeEnvironmentId(route.params.environmentId));
  const orgId = Option.getOrNull(decodeOrgId(route.params.orgId));
  if (environmentId === null || orgId === null) {
    return (
      <KinWorkMessage title={KIN_WORK_TITLE}>
        <EmptyState
          variant="plain"
          title="This link doesn't open anything"
          detail="Open Work from your Kin chats."
        />
      </KinWorkMessage>
    );
  }
  return (
    <KinPlace
      environmentId={environmentId}
      orgId={orgId}
      place={kinWorkPlaceParam(route.params.show)}
      party={kinWorkRefParam(route.params.party, route.params.partyName)}
      project={kinWorkRefParam(route.params.project, route.params.projectName)}
      person={Option.getOrNull(decodePerson(route.params.person))}
    />
  );
}

/** Every state that isn't the list, inside the scroll view that clears the floating bar. */
function KinWorkMessage(props: { readonly title: string; readonly children: React.ReactNode }) {
  const navigation = useNavigation();
  const tab = useKinTab();
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar title={props.title} {...(tab ? {} : { onBack: () => navigation.goBack() })} />
      <ScreenContent surface="screen">
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{
            padding: 16,
            paddingBottom: kinTabFoot(tab?.bottomClearance ?? 0),
            gap: 20,
          }}
        >
          {props.children}
        </ScreenScrollView>
      </ScreenContent>
    </View>
  );
}

/** One place of Work: a tab of the Kin home inside a `KinTabContext`, or a pushed page. */
export function KinPlace(
  props: KinWorkTarget & {
    readonly place: ReturnType<typeof kinWorkPlaceParam>;
    readonly party: KinWorkRef | null;
    readonly project: KinWorkRef | null;
    /** Narrows Tasks to what this person holds. */
    readonly person?: KinPersonId | null;
  },
) {
  const target = { environmentId: props.environmentId, orgId: props.orgId };
  const state = useKinWork(target);
  const ready = state._tag === "ready";
  const hostClients = kinWorkHostClients(ready ? state.live.summary : null);
  const directory = useKinWorkDirectory(target, ready);
  const { place } = props;
  const choices = useKinWorkChoices(target, ready && hostClients && place.place === "tasks");
  const title = KIN_WORK_HOME.places[place.place];
  if (state._tag === "ready") {
    const shared = { ...target, live: state.live, stale: state.stale, directory };
    // An older server has tasks only, and a link to anything else says why.
    if (place.place !== "tasks" && !hostClients) {
      return (
        <KinWorkMessage title={title}>
          <EmptyState variant="plain" {...KIN_CLIENTS_OLDER_HOST} />
        </KinWorkMessage>
      );
    }
    if (place.place === "docs") return <KinDocsList {...shared} />;
    if (place.place === "clients") return <KinClientsList {...shared} projects={place.projects} />;
    if (place.place === "money") return <KinMoneyArea {...shared} />;
    return (
      <KinTasksList
        {...shared}
        title={title}
        choices={hostClients ? choices : null}
        initial={{
          ...KIN_WORK_DEFAULT_FILTER,
          party: props.party,
          project: props.project,
          ...(props.person == null ? {} : { owner: { _tag: "person", personId: props.person } }),
          groupBy: "me",
        }}
      />
    );
  }
  return (
    <KinWorkMessage title={title}>
      {state._tag === "refused" ? (
        <EmptyState variant="plain" {...kinWorkOnlyOwner(place.place)} />
      ) : state._tag === "offline" ? (
        <EmptyState variant="plain" {...kinWorkOffline(place.place)} />
      ) : state._tag === "failed" ? (
        <KinLoadFailed
          title={KIN_WORK_LOAD_FAILED}
          cause={null}
          onRetry={() => {
            retryKinAccess(target.environmentId);
            appAtomRegistry.refresh(kinWorkLiveAtom(target));
          }}
        />
      ) : (
        <View
          className="items-center py-12"
          accessible
          accessibilityRole="progressbar"
          accessibilityLabel={`Loading ${title}`}
        >
          <AppActivityIndicator />
        </View>
      )}
    </KinWorkMessage>
  );
}
