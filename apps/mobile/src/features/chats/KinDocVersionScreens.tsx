import { useAtomValue } from "@effect/atom-react";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { KIN_DOC_CHANGES } from "@t3tools/client-runtime/kin/kinDocChanges";
import {
  KIN_DOCS,
  KIN_SEARCH,
  kinDocDiffSummary,
  kinDocVersionView,
  type KinSearchHitView,
} from "@t3tools/client-runtime/kin/kinDocs";
import { kinWorkReadState } from "@t3tools/client-runtime/kin/kinWorkForms";
import { EnvironmentId, KinOrgId, KinRecordKey, type KinDocDetail } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useRef, useState } from "react";
import { type TextInputInstance, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListSection } from "../../components/ui/ListSection";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { Menu } from "../../components/ui/Menu";
import { Notice } from "../../components/ui/Notice";
import { SearchField } from "../../components/ui/SearchField";
import { useNowMinuteMs } from "../../lib/clock";
import { appAtomRegistry } from "../../state/atom-registry";
import { PatchDiffView } from "../review/PatchDiffView";
import { KinWorkFrame, KinWorkLoading } from "./components/KinWorkPieces";
import { KinDocChangesView } from "./KinDocChangesView";
import { KinSearchHits } from "./KinDocsList";
import { kinDocVersionParam, useKinDocRestore } from "./KinDocScreen";
import { kinClient } from "./state/kinClient";
import { useKinDoc, useKinDocHistory, useKinSearch } from "./state/useKinDocs";
import { useKinWorkDirectory, type KinWorkTarget } from "./state/useKinWork";

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeOrgId = Schema.decodeUnknownOption(KinOrgId);
const decodeKey = Schema.decodeUnknownOption(KinRecordKey);

type DocRoute = { readonly environmentId: string; readonly orgId: string; readonly doc: string };

function docTarget(params: DocRoute) {
  const environmentId = Option.getOrNull(decodeEnvironmentId(params.environmentId));
  const orgId = Option.getOrNull(decodeOrgId(params.orgId));
  const key = Option.getOrNull(decodeKey(params.doc));
  return environmentId === null || orgId === null || key === null
    ? null
    : { environmentId, orgId, docKey: key };
}

const NO_DOC = { title: "This link doesn't name a doc", detail: "Open Docs from Work." };

export type KinDocChangesParams = DocRoute & {
  /** The later version; the latest when absent. */
  readonly to?: string;
  /** The earlier one; the version before `to` when absent. */
  readonly from?: string;
};

/** What differs between two versions of a doc, in the app's own diff view. */
export function KinDocChangesScreen({ route }: StaticScreenProps<KinDocChangesParams>) {
  const navigation = useNavigation();
  const target = docTarget(route.params);
  if (target === null)
    return (
      <KinWorkFrame title="Changes" onBack={() => navigation.goBack()}>
        <EmptyState variant="plain" {...NO_DOC} />
      </KinWorkFrame>
    );
  return (
    <KinDocChanges
      {...target}
      to={kinDocVersionParam(route.params.to)}
      from={kinDocVersionParam(route.params.from)}
    />
  );
}

function KinDocChanges(
  props: KinWorkTarget & {
    readonly docKey: KinRecordKey;
    readonly to: number | null;
    readonly from: number | null;
  },
) {
  const navigation = useNavigation();
  const { environmentId, orgId, docKey: key, to, from } = props;
  const target = { environmentId, orgId };
  const { names } = useKinWorkDirectory(target, true);
  const now = new Date(useNowMinuteMs());
  const doc = useKinDoc(target, key, to);
  const restore = useKinDocRestore(target, key);
  const atom = kinClient.docDiff({
    environmentId,
    input: { orgId, key, ...(to === null ? {} : { to }), ...(from === null ? {} : { from }) },
  });
  const state = kinWorkReadState(useAtomValue(atom));
  const [source, setSource] = useState(false);
  const fromVersion = state._tag === "ready" ? state.value.from.version : null;
  // The earlier version's own words, to read the two as one document.
  const before = useKinDoc(target, key, fromVersion ?? to);
  const frame = (children: React.ReactNode) => (
    <KinWorkFrame title="Changes" onBack={() => navigation.goBack()}>
      {children}
    </KinWorkFrame>
  );
  if (to === 1 && from === null)
    return frame(<EmptyState variant="plain" {...KIN_DOCS.firstVersion} />);
  if (state._tag === "refused" || doc.state._tag === "refused")
    return frame(<EmptyState variant="plain" {...KIN_DOCS.unavailable} />);
  if (state._tag === "gone") return frame(<EmptyState variant="plain" {...KIN_DOCS.gone} />);
  if (state._tag === "failed")
    return frame(
      <EmptyState
        variant="plain"
        title="Couldn't load the changes"
        detail="Check your connection to the server and try again."
        action={
          <Button
            tone="secondary"
            label="Try again"
            onPress={() => appAtomRegistry.refresh(atom)}
          />
        }
      />,
    );
  if (state._tag === "loading" || doc.state._tag !== "ready")
    return frame(<KinWorkLoading label="Loading changes" />);
  const diff = state.value;
  const held = doc.state.value;
  const latest = held.latest.version;
  const view = kinDocVersionView(diff.to, latest, names, now);
  return frame(
    <>
      <View className="gap-1 px-2">
        <Text
          textRole="headline"
          accessibilityRole="header"
          className="font-t3-bold text-foreground"
        >
          {held.title}
        </Text>
        <Text textRole="footnote" className="text-foreground-muted">
          Version {diff.from.version} to {diff.to.version} · {view.line.lead}
          {view.asked === null ? "" : ` · ${view.asked}`}
        </Text>
        {view.line.summary === null ? null : (
          <Text textRole="body" className="text-foreground">
            “{view.line.summary}”
          </Text>
        )}
      </View>
      {restore.problem === null ? null : (
        <Notice tone="danger" message={restore.problem} onDismiss={restore.dismiss} />
      )}
      {diff.patch.trim() === "" ? (
        <EmptyState variant="plain" {...KIN_DOCS.noChanges} />
      ) : !source && fromVersion !== null && before.state._tag === "loading" ? (
        <KinWorkLoading label="Loading changes" />
      ) : !source && before.state._tag === "ready" ? (
        <KinDocChangesView before={before.state.value.body} after={held.body} />
      ) : (
        <View className="overflow-hidden rounded-lg border border-border-subtle">
          <PatchDiffView
            bare
            patch={diff.patch}
            id={`kin-doc:${key}:${diff.from.version}:${diff.to.version}`}
          />
        </View>
      )}
      <Text textRole="footnote" className="px-2 text-foreground-muted">
        {kinDocDiffSummary(diff, held.outline.length)}
      </Text>
      {diff.patch.trim() === "" ? null : (
        <Button
          tone="secondary"
          label={source ? KIN_DOC_CHANGES.showDocument : KIN_DOC_CHANGES.showSource}
          onPress={() => setSource(!source)}
        />
      )}
      {!restore.allowed || diff.from.version === latest ? null : (
        <Button
          tone="secondary"
          label={restore.busy ? KIN_DOCS.restoring : `Restore version ${diff.from.version}`}
          loading={restore.busy}
          disabled={restore.busy}
          onPress={() =>
            restore.confirm(diff.from.version, latest, () =>
              navigation.dispatch(
                StackActions.popTo("KinDoc", {
                  environmentId,
                  orgId,
                  doc: key,
                  undo: String(latest),
                }),
              ),
            )
          }
        />
      )}
    </>,
  );
}

const VERSION_ACTIONS = {
  open: { id: "open", title: "Open this version", image: "doc.text" },
  changes: { id: "changes", title: KIN_DOCS.changes, image: "plus.forwardslash.minus" },
  compare: { id: "compare", title: KIN_DOCS.compare, image: "arrow.left.arrow.right" },
  restore: { id: "restore", title: KIN_DOCS.restore, image: "arrow.uturn.backward" },
} as const;

/** Every version, newest first: who made it, when and why. A tap offers what can be done with it. */
export function KinDocHistoryScreen({ route }: StaticScreenProps<DocRoute>) {
  const navigation = useNavigation();
  const target = docTarget(route.params);
  if (target === null)
    return (
      <KinWorkFrame title={KIN_DOCS.history} onClose={() => navigation.goBack()}>
        <EmptyState variant="plain" {...NO_DOC} />
      </KinWorkFrame>
    );
  return <KinDocHistory {...target} />;
}

function KinDocHistory(props: KinWorkTarget & { readonly docKey: KinRecordKey }) {
  const navigation = useNavigation();
  const { environmentId, orgId, docKey: key } = props;
  const target = { environmentId, orgId };
  const { names } = useKinWorkDirectory(target, true);
  const now = new Date(useNowMinuteMs());
  const doc = useKinDoc(target, key, null);
  const held: KinDocDetail | null = doc.state._tag === "ready" ? doc.state.value : null;
  const { state, list } = useKinDocHistory(target, key, held?.seq ?? null);
  const restore = useKinDocRestore(target, key);
  const latest = held?.latest.version ?? state.records[0]?.version ?? 0;
  const go = (version: number, action: string) => {
    const base = { environmentId, orgId, doc: key };
    if (action === "open")
      navigation.navigate("KinDoc", version === latest ? base : { ...base, v: String(version) });
    else if (action === "changes")
      navigation.navigate("KinDocChanges", { ...base, to: String(version) });
    else if (action === "compare")
      navigation.navigate("KinDocChanges", {
        ...base,
        from: String(version),
        to: String(latest),
      });
    else if (action === "restore")
      restore.confirm(version, latest, () =>
        navigation.dispatch(StackActions.popTo("KinDoc", { ...base, undo: String(latest) })),
      );
  };
  return (
    <KinWorkFrame
      title={KIN_DOCS.history}
      onClose={() => navigation.goBack()}
      refresh={{ accessibilityLabel: "Refresh", onPress: list.refresh }}
    >
      {held === null ? null : (
        <Text textRole="footnote" className="px-2 text-foreground-muted">
          {held.title}
        </Text>
      )}
      {restore.problem === null ? null : (
        <Notice tone="danger" message={restore.problem} onDismiss={restore.dismiss} />
      )}
      {doc.state._tag === "refused" ? (
        <EmptyState variant="plain" {...KIN_DOCS.unavailable} />
      ) : state.loading ? (
        <KinWorkLoading label="Loading history" />
      ) : state.failed !== null ? (
        <EmptyState
          variant="plain"
          title="Couldn't load the history"
          detail="Check your connection to the server and try again."
          action={<Button tone="secondary" label="Try again" onPress={list.refresh} />}
        />
      ) : (
        <ListSection>
          {state.records.map((version) => {
            const view = kinDocVersionView(version, latest, names, now);
            return (
              <Menu
                key={view.version}
                title={view.label}
                accessibilityRole="button"
                accessibilityLabel={`${view.accessibilityLabel}. Actions`}
                actions={[
                  VERSION_ACTIONS.open,
                  ...(view.previous === null ? [] : [VERSION_ACTIONS.changes]),
                  ...(view.current ? [] : [VERSION_ACTIONS.compare]),
                  ...(view.current || !restore.allowed ? [] : [VERSION_ACTIONS.restore]),
                ]}
                onPressAction={({ nativeEvent }) => go(view.version, nativeEvent.event)}
              >
                <View pointerEvents="none" className="gap-0.5 px-4 py-3">
                  <View className="flex-row items-center justify-between gap-3">
                    <Text textRole="body" className="font-t3-medium text-foreground">
                      {view.label}
                    </Text>
                    {view.current ? (
                      <Text textRole="footnote" className="text-foreground-muted">
                        Current
                      </Text>
                    ) : null}
                  </View>
                  <Text textRole="footnote" className="text-foreground-muted">
                    {view.line.lead}
                    {view.asked === null ? "" : ` · ${view.asked}`}
                  </Text>
                  {view.line.summary === null ? null : (
                    <Text textRole="footnote" className="text-foreground">
                      {view.line.summary}
                    </Text>
                  )}
                </View>
                <View className="ml-4 h-px bg-border-subtle" />
              </Menu>
            );
          })}
        </ListSection>
      )}
      {!state.more ? null : (
        <Button
          tone="secondary"
          size="compact"
          label={state.moreFailed ? "Try again" : "Show earlier versions"}
          loading={state.loadingMore}
          disabled={state.loadingMore}
          onPress={() => void list.loadMore()}
        />
      )}
    </KinWorkFrame>
  );
}

export type KinSearchParams = { readonly environmentId: string; readonly orgId: string };

/** One search box over tasks, clients, contacts, projects and docs. */
export function KinSearchScreen({ route }: StaticScreenProps<KinSearchParams>) {
  const navigation = useNavigation();
  const environmentId = Option.getOrNull(decodeEnvironmentId(route.params.environmentId));
  const orgId = Option.getOrNull(decodeOrgId(route.params.orgId));
  if (environmentId === null || orgId === null)
    return (
      <KinWorkFrame title={KIN_SEARCH.title} onClose={() => navigation.goBack()}>
        <EmptyState
          variant="plain"
          title="This link doesn't open anything"
          detail="Open Work from your Kin chats."
        />
      </KinWorkFrame>
    );
  return <KinSearch environmentId={environmentId} orgId={orgId} />;
}

function KinSearch(props: KinWorkTarget) {
  const navigation = useNavigation();
  const { environmentId, orgId } = props;
  const { state, search } = useKinSearch(props, null);
  const input = useRef<TextInputInstance>(null);
  const open = (hit: KinSearchHitView) => {
    const base = { environmentId, orgId };
    if (hit.kind === "docs")
      navigation.navigate("KinDoc", {
        ...base,
        doc: hit.key,
        ...(hit.section === null ? {} : { section: hit.section.id }),
      });
    else if (hit.kind === "clients") navigation.navigate("KinClient", { ...base, party: hit.key });
    else if (hit.kind === "projects")
      navigation.navigate("KinProject", { ...base, project: hit.key });
    // A contact has no page of its own; its entry lists who it is with.
    else navigation.navigate("KinWorkItem", { ...base, task: hit.key });
  };
  return (
    <KinWorkFrame form title={KIN_SEARCH.title} onClose={() => navigation.goBack()}>
      <View className="flex-row">
        <SearchField
          inputRef={input}
          accessibilityLabel={KIN_SEARCH.placeholder}
          clearAccessibilityLabel="Clear search"
          placeholder={KIN_SEARCH.placeholder}
          value={state.text}
          onChangeText={search.setText}
        />
      </View>
      <ListSection>
        <ListToggleRow
          label={KIN_SEARCH.includeClosed}
          value={state.closed}
          onValueChange={search.setClosed}
        />
      </ListSection>
      {state.text.trim() === "" ? (
        <EmptyState variant="plain" {...KIN_SEARCH.hint} />
      ) : (
        <View className="-mx-4">
          <KinSearchHits state={state} onRetry={search.retry} onOpen={open} />
        </View>
      )}
    </KinWorkFrame>
  );
}
