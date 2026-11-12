import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  kinBodyMarkdown,
  kinImageSource,
  kinImageText,
} from "@t3tools/client-runtime/kin/kinChatFeed";
import { kinLinkToOpen } from "@t3tools/client-runtime/kin/kinChatFeed";
import {
  KIN_DOCS,
  kinDocChangeLine,
  kinDocChat,
  kinDocExport,
  kinDocHasContents,
  kinDocOutline,
  kinDocPrevious,
  kinDocPrivacy,
  kinDocRef,
  kinDocRestoreOutcome,
  kinDocSections,
  kinPendingRefAtom,
  kinPendingRefKey,
  type KinDocAsk,
} from "@t3tools/client-runtime/kin/kinDocs";
import { EnvironmentId, KinOrgId, KinRecordKey, type KinDocDetail } from "@t3tools/contracts";
import * as Linking from "expo-linking";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useRef, useState, type ComponentRef } from "react";
import { File, Paths } from "expo-file-system";
import { Alert, Pressable, View } from "react-native";

import { AppBar } from "../../components/ui/AppBar";
import type { AppBarMenu } from "../../components/ui/AppBar.types";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { Menu } from "../../components/ui/Menu";
import { Notice } from "../../components/ui/Notice";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { useNowMinuteMs } from "../../lib/clock";
import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { shareFileFromSource } from "../../lib/shareFileFromSource";
import {
  SelectableMarkdownText,
  type MarkdownImageRenderer,
} from "../../native/SelectableMarkdownText";
import { appAtomRegistry } from "../../state/atom-registry";
import { useAtomCommand } from "../../state/use-atom-command";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import { useOpenPullRequest } from "../../native/useOpenPullRequest";
import { KinWorkFrame, KinWorkLoading } from "./components/KinWorkPieces";
import { kinClient } from "./state/kinClient";
import { useKinDoc } from "./state/useKinDocs";
import { kinHostConnected } from "./state/useKinHost";
import { useKinInbox } from "./state/useKinInbox";
import { useKinWorkDirectory, type KinWorkTarget } from "./state/useKinWork";

export type KinDocParams = {
  readonly environmentId: string;
  readonly orgId: string;
  /** The doc's short handle, such as `D-3`. */
  readonly doc: string;
  /** The section to arrive at. */
  readonly section?: string;
  /** An earlier version to read; the latest otherwise. */
  readonly v?: string;
};

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeOrgId = Schema.decodeUnknownOption(KinOrgId);
const decodeKey = Schema.decodeUnknownOption(KinRecordKey);

export const kinDocVersionParam = (raw: string | undefined): number | null => {
  const version = Number(raw);
  return raw !== undefined && Number.isSafeInteger(version) && version > 0 ? version : null;
};

const renderImageAsText: MarkdownImageRenderer = (image) => (
  <Text textRole="body" className="italic text-foreground-muted">
    {kinImageText(image)}
  </Text>
);

const SECTION_ACTIONS = [
  { id: "ask", title: KIN_DOCS.ask, image: "questionmark.bubble" },
  { id: "change", title: KIN_DOCS.change, image: "pencil" },
  { id: "link", title: KIN_DOCS.copyLink, image: "link" },
  { id: "copy", title: "Copy text", image: "doc.on.doc" },
] as const;

/** A doc as a document: who last changed it and how, then everything the agent wrote. */
export function KinDocScreen({ route }: StaticScreenProps<KinDocParams>) {
  const navigation = useNavigation();
  const environmentId = Option.getOrNull(decodeEnvironmentId(route.params.environmentId));
  const orgId = Option.getOrNull(decodeOrgId(route.params.orgId));
  const key = Option.getOrNull(decodeKey(route.params.doc));
  if (environmentId === null || orgId === null || key === null) {
    return (
      <KinWorkFrame title="Doc" onBack={() => navigation.goBack()}>
        <EmptyState
          variant="plain"
          title="This link doesn't name a doc"
          detail="Open Docs from Work."
        />
      </KinWorkFrame>
    );
  }
  return (
    <KinDocStates
      // A fresh screen per doc and version, so one's sections never serve another's.
      key={`${key}:${route.params.v ?? ""}`}
      environmentId={environmentId}
      orgId={orgId}
      docKey={key}
      version={kinDocVersionParam(route.params.v)}
      section={route.params.section ?? null}
    />
  );
}

type DocTarget = KinWorkTarget & {
  readonly docKey: KinRecordKey;
  readonly version: number | null;
  readonly section: string | null;
};

function KinDocStates(props: DocTarget) {
  const navigation = useNavigation();
  const { state, refresh } = useKinDoc(props, props.docKey, props.version);
  if (state._tag === "ready")
    return <KinDocBody {...props} doc={state.value} stale={state.stale} onRefresh={refresh} />;
  return (
    <KinWorkFrame title="Doc" onBack={() => navigation.goBack()}>
      {state._tag === "loading" ? (
        <KinWorkLoading label="Loading doc" />
      ) : state._tag === "gone" ? (
        <EmptyState variant="plain" {...KIN_DOCS.gone} />
      ) : state._tag === "refused" ? (
        <EmptyState variant="plain" {...KIN_DOCS.unavailable} />
      ) : (
        <EmptyState
          variant="plain"
          {...KIN_DOCS.failed}
          action={<Button tone="secondary" label="Try again" onPress={refresh} />}
        />
      )}
    </KinWorkFrame>
  );
}

/** Restores a version after asking, and says in words why it couldn't when it can't. */
export function useKinDocRestore(target: KinWorkTarget, key: KinRecordKey) {
  const { environmentId, orgId } = target;
  const allowed = useAtomValue(kinClient.docRestore.permissionAtom(environmentId));
  const send = useAtomCommand(kinClient.docRestore, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const run = async (version: number, latest: number): Promise<KinDocDetail | null> => {
    if (!kinHostConnected(environmentId)) {
      setProblem("You're offline. Restore it when the connection is back.");
      return null;
    }
    setBusy(true);
    setProblem(null);
    const outcome = kinDocRestoreOutcome(
      await send({ environmentId, input: { orgId, key, version, latest } }),
    );
    setBusy(false);
    if (outcome._tag === "restored") return outcome.doc;
    setProblem(outcome.text);
    return null;
  };
  return {
    allowed,
    busy,
    problem,
    dismiss: () => setProblem(null),
    run,
    /** Asks first. A restore loses nothing, so the question says so. */
    confirm: (version: number, latest: number, then: (doc: KinDocDetail) => void) =>
      Alert.alert(
        `Restore version ${version}?`,
        `The doc will read as it did at version ${version}. Nothing is lost: the restore is saved as a new version, and you can undo it.`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Restore",
            onPress: () =>
              void run(version, latest).then((doc) => {
                if (doc !== null) then(doc);
              }),
          },
        ],
      ),
  };
}

function KinDocBody(
  props: DocTarget & {
    readonly doc: KinDocDetail;
    readonly stale: boolean;
    readonly onRefresh: () => void;
  },
) {
  const navigation = useNavigation();
  const { environmentId, orgId, doc } = props;
  const target = { environmentId, orgId };
  const { names } = useKinWorkDirectory(target, true);
  const inbox = useKinInbox();
  const now = new Date(useNowMinuteMs());
  const styles = useMarkdownPreviewStyles();
  const openLink = useOpenPullRequest();
  const restore = useKinDocRestore(target, doc.key);
  const scroll = useRef<ComponentRef<typeof ScreenScrollView>>(null);
  const offsets = useRef(new Map<string, number>());
  const arrived = useRef(false);
  const [copied, setCopied] = useState(false);
  /** The version that was latest before a restore, which restoring again undoes. */
  const [undo, setUndo] = useState<number | null>(null);

  const sections = kinDocSections(doc.body, doc.outline);
  const outline = kinDocOutline(doc.outline);
  const line = kinDocChangeLine(
    {
      at: doc.version.at,
      kind: doc.version.kind,
      summary: doc.version.summary,
      by: doc.version.provenance.by,
    },
    names,
    now,
  );
  const old = doc.version.version !== doc.latest.version;
  const previous = kinDocPrevious(doc.version);
  const privacy = kinDocPrivacy(doc);
  const chats = inbox.state._tag === "ready" ? inbox.state.inbox.value.chats : [];
  const chat = kinDocChat(chats, doc, names.me);
  const first = doc.outline.find((section) => section.id !== "top");
  const titled =
    doc.outline[0]?.id !== "top" &&
    first?.level === 1 &&
    first.title.trim().toLowerCase() === doc.title.toLowerCase();

  const point = (section: string | null, intent: KinDocAsk) => {
    if (chat === null) {
      Alert.alert("Nobody to ask yet", KIN_DOCS.noAgent);
      return;
    }
    appAtomRegistry.set(kinPendingRefAtom(kinPendingRefKey(environmentId, chat.chatId)), {
      ref: kinDocRef(doc, section),
      intent,
    });
    navigation.navigate("KinChat", { environmentId, orgId, chatId: chat.chatId });
  };
  const copyLink = async (section: string | null) => {
    const url = Linking.createURL(`kin/${environmentId}/${orgId}/docs/${doc.key}`, {
      queryParams: section === null ? {} : { section },
    });
    if (await tryCopyTextWithHaptic(url, { target: "link" })) setCopied(true);
  };
  const share = async () => {
    const exported = kinDocExport(doc);
    const file = new File(Paths.cache, exported.filename);
    if (file.exists) file.delete();
    file.create();
    file.write(exported.text);
    await shareFileFromSource(
      file.uri,
      { mimeType: "text/markdown", UTI: "net.daringfireball.markdown", dialogTitle: doc.title },
      "kin-doc",
    );
  };
  const jump = (id: string) => {
    const y = id === "top" ? 0 : offsets.current.get(id);
    if (y !== undefined) scroll.current?.scrollTo({ y, animated: true });
  };
  const act = (section: string | null, text: string, action: string) => {
    if (action === "ask" || action === "change") point(section, action);
    else if (action === "link") void copyLink(section);
    else if (action === "copy") void tryCopyTextWithHaptic(text, { target: "section" });
  };
  const onLinkPress = (href: string) => {
    const url = kinLinkToOpen(href);
    if (url !== null) void openLink(url);
  };

  const menus: ReadonlyArray<AppBarMenu> = [
    ...(kinDocHasContents(doc.outline) && sections !== null
      ? [
          {
            title: KIN_DOCS.contents,
            icon: "text.alignleft" as const,
            items: outline.map((row) => ({
              id: row.id,
              title: `${"    ".repeat(row.depth)}${row.title}`,
              onPress: () => jump(row.id),
            })),
          },
        ]
      : []),
    {
      title: "More",
      icon: "ellipsis" as const,
      items: [
        { id: "ask", title: KIN_DOCS.ask, onPress: () => point(null, "ask") },
        { id: "change", title: KIN_DOCS.change, onPress: () => point(null, "change") },
        { id: "link", title: KIN_DOCS.copyLink, onPress: () => void copyLink(null) },
        {
          id: "history",
          title: KIN_DOCS.history,
          onPress: () =>
            navigation.navigate("KinDocHistory", { environmentId, orgId, doc: doc.key }),
        },
        { id: "export", title: KIN_DOCS.export, onPress: () => void share() },
      ],
    },
  ];

  const markdown = (text: string) => (
    <SelectableMarkdownText
      markdown={kinBodyMarkdown(text)}
      textStyle={styles.nativeTextStyle}
      // A long press opens the section's own actions, which include copying its text.
      selectable={false}
      inlineWebLinks
      onLinkPress={onLinkPress}
      renderImage={renderImageAsText}
      resolveImageSource={kinImageSource}
    />
  );

  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar
        title="Doc"
        onBack={() => navigation.goBack()}
        refresh={{ accessibilityLabel: "Refresh", onPress: props.onRefresh }}
        menus={menus}
      />
      <ScreenContent surface="screen">
        <ScreenScrollView
          ref={scroll}
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: 48 }}
        >
          <View className="gap-2 pb-3">
            {titled ? null : (
              <Text
                textRole="title"
                accessibilityRole="header"
                className="font-t3-bold text-foreground"
              >
                {doc.title}
              </Text>
            )}
            <Text textRole="footnote" className="text-foreground-muted">
              {line.text}
            </Text>
            {previous === null ? null : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={KIN_DOCS.changes}
                hitSlop={12}
                onPress={() =>
                  navigation.navigate("KinDocChanges", {
                    environmentId,
                    orgId,
                    doc: doc.key,
                    to: String(doc.version.version),
                  })
                }
                className="self-start active:opacity-60"
              >
                <Text textRole="footnote" className="font-t3-medium text-foreground underline">
                  {KIN_DOCS.changes}
                </Text>
              </Pressable>
            )}
            {privacy === null ? null : (
              <View className="flex-row items-center gap-1.5">
                <SymbolView
                  name="lock"
                  size={12}
                  tintColorClassName="accent-icon-muted"
                  type="monochrome"
                />
                <Text textRole="footnote" className="shrink text-foreground-muted">
                  {privacy}
                </Text>
              </View>
            )}
            {props.stale ? <Notice message="Offline. Showing the last copy read." /> : null}
            {restore.problem === null ? null : (
              <Notice tone="danger" message={restore.problem} onDismiss={restore.dismiss} />
            )}
            {copied ? (
              <Notice message={KIN_DOCS.copied} onDismiss={() => setCopied(false)} />
            ) : null}
            {undo === null ? null : (
              <Notice
                message={`Restored. This is now version ${doc.latest.version}, and nothing was lost.`}
                action={{
                  label: "Undo",
                  pending: restore.busy,
                  onPress: () =>
                    void restore.run(undo, doc.latest.version).then((restored) => {
                      if (restored === null) return;
                      setUndo(null);
                      props.onRefresh();
                    }),
                }}
              />
            )}
            {old ? (
              <View className="gap-2">
                <Notice
                  message={`You're reading version ${doc.version.version}. The latest is version ${doc.latest.version}.`}
                  action={{
                    label: "Open the latest",
                    onPress: () => navigation.setParams({ v: undefined }),
                  }}
                />
                {restore.allowed ? (
                  <Button
                    tone="secondary"
                    size="compact"
                    label={restore.busy ? KIN_DOCS.restoring : KIN_DOCS.restore}
                    loading={restore.busy}
                    disabled={restore.busy}
                    onPress={() =>
                      restore.confirm(doc.version.version, doc.latest.version, () => {
                        setUndo(doc.latest.version);
                        navigation.setParams({ v: undefined });
                      })
                    }
                  />
                ) : null}
              </View>
            ) : null}
          </View>
          {doc.body.trim() === "" ? (
            <Text textRole="body" className="text-foreground-muted">
              This doc has no text yet.
            </Text>
          ) : sections === null ? (
            <Menu
              shouldOpenOnLongPress
              actions={SECTION_ACTIONS.map((action) => ({ ...action }))}
              onPressAction={({ nativeEvent }) => act(null, doc.body, nativeEvent.event)}
            >
              <View>{markdown(doc.body)}</View>
            </Menu>
          ) : (
            sections.map((section) => (
              <View
                key={section.id}
                onLayout={(event) => {
                  offsets.current.set(section.id, event.nativeEvent.layout.y);
                  // Arriving from a link or a search hit, the page opens at its section.
                  if (section.id === props.section && !arrived.current) {
                    arrived.current = true;
                    scroll.current?.scrollTo({ y: event.nativeEvent.layout.y, animated: false });
                  }
                }}
              >
                <Menu
                  title={section.title}
                  shouldOpenOnLongPress
                  accessibilityLabel={`${section.title}. Hold for actions`}
                  actions={SECTION_ACTIONS.map((action) => ({ ...action }))}
                  onPressAction={({ nativeEvent }) =>
                    act(section.id, section.text, nativeEvent.event)
                  }
                >
                  <View>{markdown(section.text)}</View>
                </Menu>
              </View>
            ))
          )}
        </ScreenScrollView>
      </ScreenContent>
    </View>
  );
}
