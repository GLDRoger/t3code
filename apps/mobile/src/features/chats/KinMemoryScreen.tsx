import { LegendList } from "@legendapp/list/react-native";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  KIN_MEMORY_EMPTY,
  KIN_MEMORY_FORGET,
  KIN_MEMORY_LOAD_FAILED,
  KIN_MEMORY_NO_EDITS,
  KIN_MEMORY_SEARCH_PLACEHOLDER,
  KIN_MEMORY_TITLE,
  createKinMemoryActions,
  kinMemoryEntrySummary,
  kinMemoryView,
  type KinMemoryActions,
  type KinMemoryConfirmAll,
  type KinMemoryOriginView,
  type KinMemoryRow,
} from "@t3tools/client-runtime/kin/kinMemoryScreen";
import {
  EnvironmentId,
  KinOrgId,
  type KinLeadsListResult,
  type KinMemoryListResult,
  type KinPeopleListResult,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppBar } from "../../components/ui/AppBar";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { confirm as confirmDialog } from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { appAtomRegistry } from "../../state/atom-registry";
import { useAtomCommand } from "../../state/use-atom-command";
import { KinListBanner } from "./components/KinListBanner";
import { kinClient } from "./state/kinClient";

export type KinMemoryParams = { readonly environmentId: string; readonly orgId: string };

interface KinMemoryTarget {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
}

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeOrgId = Schema.decodeUnknownOption(KinOrgId);

type MemoryResult = AsyncResult.AsyncResult<KinMemoryListResult, unknown>;
// Read only by a session that may change this; others ask the host nothing.
const noMemoryAtom: Atom.Atom<MemoryResult> = Atom.make(AsyncResult.initial());
const noPeopleAtom: Atom.Atom<AsyncResult.AsyncResult<KinPeopleListResult, unknown>> = Atom.make(
  AsyncResult.initial(),
);
const noAgentsAtom: Atom.Atom<AsyncResult.AsyncResult<KinLeadsListResult, unknown>> = Atom.make(
  AsyncResult.initial(),
);

/** The way in from the chat list, for the owner only. Its second line says how much waits. */
export function KinMemoryEntry({ environmentId, orgId }: KinMemoryTarget) {
  const navigation = useNavigation();
  const allowed = useAtomValue(kinClient.memorySetVisibility.permissionAtom(environmentId));
  const result = useAtomValue(
    allowed ? kinClient.memory({ environmentId, input: { orgId } }) : noMemoryAtom,
  );
  const list = Option.getOrNull(AsyncResult.value(result));
  // A failure with nothing read: the host refused, or is away and the page couldn't load either.
  if (!allowed || (list === null && AsyncResult.isFailure(result))) return null;
  return (
    <KinMemoryEntryRow
      summary={kinMemoryEntrySummary(list)}
      onPress={() => navigation.navigate("KinMemory", { environmentId, orgId })}
    />
  );
}

/** Also drawn from fixtures in the component catalog. */
export function KinMemoryEntryRow(props: {
  readonly summary: string;
  readonly onPress: () => void;
}) {
  return (
    <>
      <KinListBanner
        title={KIN_MEMORY_TITLE}
        summary={props.summary}
        symbol="brain"
        accessibilityLabel={`${KIN_MEMORY_TITLE}. ${props.summary}`}
        accessibilityHint="Opens what your agents remember"
        onPress={props.onPress}
      />
      <View className="ml-5 h-px bg-border-subtle" />
    </>
  );
}

/** What the owner's leads remember, and who may know each thing. */
export function KinMemoryScreen({ route }: StaticScreenProps<KinMemoryParams>) {
  const navigation = useNavigation();
  const environmentId = Option.getOrNull(decodeEnvironmentId(route.params.environmentId));
  const orgId = Option.getOrNull(decodeOrgId(route.params.orgId));
  if (environmentId === null || orgId === null) {
    return (
      <View collapsable={false} className="flex-1 bg-screen">
        <AppBar title={KIN_MEMORY_TITLE} onBack={() => navigation.goBack()} />
        <ScreenContent surface="screen">
          <ScreenScrollView
            className="flex-1"
            contentInsetAdjustmentBehavior="automatic"
            contentContainerStyle={{ padding: 16 }}
          >
            <EmptyState
              variant="plain"
              title="This link doesn't open anything"
              detail="Open Memory from your Kin chats."
            />
          </ScreenScrollView>
        </ScreenContent>
      </View>
    );
  }
  return <KinMemoryBody environmentId={environmentId} orgId={orgId} />;
}

function KinMemoryBody({ environmentId, orgId }: KinMemoryTarget) {
  const navigation = useNavigation();
  const allowed = useAtomValue(kinClient.memorySetVisibility.permissionAtom(environmentId));
  const listAtom = kinClient.memory({ environmentId, input: { orgId } });
  const result = useAtomValue(allowed ? listAtom : noMemoryAtom);
  const setVisibility = useAtomCommand(kinClient.memorySetVisibility, { reportFailure: false });
  const confirm = useAtomCommand(kinClient.memoryConfirm, { reportFailure: false });
  const forget = useAtomCommand(kinClient.memoryForget, { reportFailure: false });
  const [edits, setEdits] = useState(KIN_MEMORY_NO_EDITS);
  const [search, setSearch] = useState("");
  // Whose words and which agent an item names; until these arrive a row says "a teammate" or "an agent".
  const people = useAtomValue(
    allowed ? kinClient.people({ environmentId, input: { orgId } }) : noPeopleAtom,
  );
  const agents = useAtomValue(
    allowed
      ? kinClient.leads({ environmentId, input: { orgId, includeRetired: true } })
      : noAgentsAtom,
  );
  // Quotes read in full, kept here because the list recycles its rows.
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const [actions] = useState(() =>
    createKinMemoryActions({
      orgId,
      setVisibility: (input) => setVisibility({ environmentId, input }),
      confirmSuggestions: (input) => confirm({ environmentId, input }),
      forget: (input) => forget({ environmentId, input }),
      update: setEdits,
      refresh: () => appAtomRegistry.refresh(listAtom),
    }),
  );
  // What was last read stays up while it is read again.
  const list = Option.getOrNull(AsyncResult.value(result));
  const view =
    list === null
      ? null
      : kinMemoryView(list, edits, search, {
          people: Option.getOrNull(AsyncResult.value(people))?.people ?? [],
          agents: Option.getOrNull(AsyncResult.value(agents))?.leads ?? [],
        });
  const message = !allowed ? (
    <EmptyState
      variant="plain"
      title="Only the owner can open this"
      detail="What the agents remember is shown to the person who runs this workspace."
    />
  ) : list === null || view === null ? (
    AsyncResult.isFailure(result) ? (
      <EmptyState
        variant="plain"
        title={KIN_MEMORY_LOAD_FAILED}
        detail="Check your connection to the server and try again."
        action={
          <Button
            tone="secondary"
            label="Try again"
            onPress={() => appAtomRegistry.refresh(listAtom)}
          />
        }
      />
    ) : (
      <View
        className="items-center py-12"
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel="Loading what your agents remember"
      >
        <AppActivityIndicator />
      </View>
    )
  ) : view.total === 0 ? (
    <EmptyState variant="plain" {...KIN_MEMORY_EMPTY} />
  ) : view.noMatch !== null ? (
    <EmptyState variant="plain" title={view.noMatch} detail="Try another word." />
  ) : null;
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar
        title={KIN_MEMORY_TITLE}
        onBack={() => navigation.goBack()}
        {...(list === null
          ? {}
          : {
              refresh: {
                accessibilityLabel: "Refresh",
                onPress: () => appAtomRegistry.refresh(listAtom),
              },
            })}
        {...(view?.searchable
          ? {
              search: {
                value: search,
                onChangeText: setSearch,
                placeholder: KIN_MEMORY_SEARCH_PLACEHOLDER,
                closeAccessibilityLabel: "Close search",
                clearAccessibilityLabel: "Clear search",
              },
            }
          : {})}
      />
      <ScreenContent surface="screen">
        {message !== null || list === null || view === null ? (
          <ScreenScrollView
            className="flex-1"
            contentInsetAdjustmentBehavior="automatic"
            keyboardDismissMode="on-drag"
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 20 }}
          >
            {message}
          </ScreenScrollView>
        ) : (
          <LegendList
            renderScrollComponent={NativeScrollView}
            className="flex-1"
            contentInsetAdjustmentBehavior="automatic"
            keyboardDismissMode="on-drag"
            keyboardShouldPersistTaps="handled"
            // The search field floats over the foot of the list.
            contentContainerStyle={{ paddingBottom: view.searchable ? 96 : 32 }}
            data={view.rows}
            keyExtractor={(row) => row.key}
            getItemType={(row) => row.type}
            extraData={[view.confirmAll, opened]}
            estimatedItemSize={96}
            recycleItems
            ListHeaderComponent={
              edits.problem === null ? null : (
                <View className="px-4 pt-3">
                  <ErrorBanner message={edits.problem} />
                </View>
              )
            }
            renderItem={({ item: row }) =>
              row.type === "section" ? (
                <KinMemorySection
                  row={row}
                  confirmAll={row.state === "suggested" ? view.confirmAll : null}
                  onConfirmAll={(all) => void actions.confirmAll(list, all)}
                />
              ) : (
                <KinMemoryItem
                  row={row}
                  list={list}
                  actions={actions}
                  quoteOpen={opened.has(row.item.itemId)}
                  onToggleQuote={() =>
                    setOpened((current) => {
                      const next = new Set(current);
                      if (!next.delete(row.item.itemId)) next.add(row.item.itemId);
                      return next;
                    })
                  }
                />
              )
            }
          />
        )}
      </ScreenContent>
    </View>
  );
}

function KinMemorySection(props: {
  readonly row: Extract<KinMemoryRow, { readonly type: "section" }>;
  readonly confirmAll: KinMemoryConfirmAll | null;
  readonly onConfirmAll: (all: KinMemoryConfirmAll) => void;
}) {
  const { row, confirmAll } = props;
  return (
    <View className="gap-3 px-5 pb-2 pt-6">
      <View className="gap-1">
        <Text
          textRole="headline"
          accessibilityRole="header"
          className="font-t3-bold text-foreground"
        >
          {row.title}
          <Text textRole="headline" className="font-sans text-foreground-muted">
            {`  ${row.count}`}
          </Text>
        </Text>
        <Text textRole="footnote" className="text-foreground-muted">
          {row.hint}
        </Text>
      </View>
      {confirmAll === null ? null : (
        <Button
          tone="primary"
          size="compact"
          label={confirmAll.label}
          onPress={() => props.onConfirmAll(confirmAll)}
        />
      )}
    </View>
  );
}

function KinMemoryItem(props: {
  readonly row: Extract<KinMemoryRow, { readonly type: "item" }>;
  readonly list: KinMemoryListResult;
  readonly actions: KinMemoryActions;
  readonly quoteOpen: boolean;
  readonly onToggleQuote: () => void;
}) {
  const { item } = props.row;
  return (
    <View className="ml-5 gap-2 border-t border-border-subtle py-3 pr-5">
      <View className="gap-1">
        <Text textRole="body" className="text-foreground">
          {item.title}
        </Text>
        {item.preview === null ? null : (
          <Text textRole="footnote" numberOfLines={2} className="text-foreground-muted">
            {item.preview}
          </Text>
        )}
        {item.from === null ? null : (
          <Text textRole="footnote" className="text-foreground-muted">
            {item.from}
          </Text>
        )}
        {item.origin === null ? null : (
          <KinMemoryOrigin
            origin={item.origin}
            open={props.quoteOpen}
            onToggle={props.onToggleQuote}
          />
        )}
      </View>
      <View className="flex-row flex-wrap gap-2">
        {item.actions.map((action) => (
          <Button
            key={action.to}
            tone={action.to === "team" ? "secondary" : "text"}
            size="compact"
            label={action.label}
            accessibilityLabel={action.accessibilityLabel}
            disabled={item.busy}
            onPress={() => void props.actions.change(props.list, item.itemId, action.to)}
          />
        ))}
        <Button
          tone="text"
          size="compact"
          label={item.forget.label}
          accessibilityLabel={item.forget.accessibilityLabel}
          disabled={item.busy}
          onPress={() =>
            confirmDialog({
              title: KIN_MEMORY_FORGET.title,
              message: KIN_MEMORY_FORGET.body(item.title),
              confirmText: KIN_MEMORY_FORGET.action,
              destructive: true,
              onConfirm: () => void props.actions.forget(props.list, item.itemId),
            })
          }
        />
      </View>
    </View>
  );
}

const ORIGIN_SYMBOL: Record<KinMemoryOriginView["kind"], AppSymbolName> = {
  said: "bubble.left",
  worked_out: "sparkles",
  outside: "globe",
};

/** One quiet line: who said it or which agent worked it out, when, and the words if any. */
function KinMemoryOrigin(props: {
  readonly origin: KinMemoryOriginView;
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  const { origin, open } = props;
  const line = (
    <>
      <View className="h-[18px] justify-center">
        <SymbolView
          name={ORIGIN_SYMBOL[origin.kind]}
          size={12}
          tintColorClassName="accent-icon-muted"
          type="monochrome"
        />
      </View>
      <Text
        textRole="footnote"
        numberOfLines={open ? undefined : 2}
        className="min-w-0 flex-1 text-foreground-muted"
      >
        {origin.line}
        {origin.quote === null ? null : (
          <Text textRole="footnote" className="text-foreground">
            {` “${origin.quote}”`}
          </Text>
        )}
      </Text>
    </>
  );
  return origin.quote === null ? (
    <View className="flex-row items-start gap-1.5">{line}</View>
  ) : (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      accessibilityHint={open ? "Shows less" : "Shows the whole quote"}
      onPress={props.onToggle}
      className="flex-row items-start gap-1.5 active:opacity-60"
    >
      {line}
    </Pressable>
  );
}
