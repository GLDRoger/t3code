import { getComposerDraftSnapshot, setComposerDraftText } from "../../state/use-composer-drafts";
import { kinDraftKey } from "./state/kinDraftKey";
import { useKinIsOwnerLevel } from "./state/kinChatOnly";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { KIN_RETRY, kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  kinDocFileId,
  kinDocMarkdown,
  kinImageSource,
  kinImageText,
} from "@t3tools/client-runtime/kin/kinChatFeed";
import { kinLinkToOpen } from "@t3tools/client-runtime/kin/kinChatFeed";
import {
  KIN_DOCS,
  KIN_DOC_HOMES,
  KIN_DOC_KIND_LABELS,
  kinDocKindOf,
  kinDocUnfiled,
  kinDocChangeItem,
  kinDocChangeLine,
  kinDocDeletedLine,
  kinDocCanEdit,
  kinDocChat,
  kinDocCopyText,
  kinDocEditInput,
  kinDocEditOpen,
  kinDocEditOutcome,
  kinDocSuggestStarter,
  kinDocExport,
  kinDocHasContents,
  kinDocOutline,
  kinDocPdfInput,
  kinDocPieceKey,
  kinDocPieces,
  kinDocPrevious,
  kinDocPrivacy,
  kinDocRef,
  kinDocRestoreOutcome,
  kinDocSections,
  kinPendingRefAtom,
  kinPendingRefKey,
  type KinDocAsk,
  type KinDocEditOpened,
} from "@t3tools/client-runtime/kin/kinDocs";
import { KIN_DOC_COMPANY, KIN_DOC_SHARE } from "@t3tools/client-runtime/kin/kinWork";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { EnvironmentId, KinOrgId, KinRecordKey, type KinDocDetail } from "@t3tools/contracts";
import * as Linking from "expo-linking";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import * as Schema from "effect/Schema";
import { Fragment, useRef, useState, type ComponentRef, type ReactNode } from "react";
import { File, Paths } from "expo-file-system";
import { Alert, Pressable, TextInput, View } from "react-native";

import { AppBar } from "../../components/ui/AppBar";
import type { AppBarMenu } from "../../components/ui/AppBar.types";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { FilePreviewModal, type FilePreviewSource } from "../../components/ui/FilePreviewModal";
import { ListSection } from "../../components/ui/ListSection";
import { Menu } from "../../components/ui/Menu";
import { Chip } from "../../components/ui/Chip";
import { Notice } from "../../components/ui/Notice";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { useContentTopInset } from "../../components/ui/useBarInset";
import { useNowMinuteMs } from "../../lib/clock";
import { uuidv4 } from "../../lib/uuid";
import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { shareFileFromSource } from "../../lib/shareFileFromSource";
import {
  SelectableMarkdownText,
  type MarkdownImageRenderer,
  type MarkdownImageSourceResolver,
} from "../../native/SelectableMarkdownText";
import { assetEnvironment } from "../../state/assets";
import { appAtomRegistry } from "../../state/atom-registry";
import { usePreparedConnection } from "../../state/session";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { useAtomCommand } from "../../state/use-atom-command";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import { useOpenPullRequest } from "../../native/useOpenPullRequest";
import { ThreadMarkdownImage } from "../threads/ThreadMarkdownImage";
import { KinWorkFrame, KinWorkLoading } from "./components/KinWorkPieces";
import { KinDocFileRows } from "./KinInvoice";
import { KinLinkedSection, useKinOpenLinked } from "./KinWorkItemScreen";
import { KinWorkShareRow } from "./KinWorkShareRow";
import { kinClient } from "./state/kinClient";
import { useKinDocLabel } from "./state/useKinDocLabel";
import { useKinDocDelete } from "./state/useKinDocDelete";
import { useKinDoc } from "./state/useKinDocs";
import { useKinWorkLink } from "./state/kinWorkLink";
import { kinHostConnected } from "./state/useKinHost";
import { useKinInbox } from "./state/useKinInbox";
import { useKinWorkDirectory, type KinWorkTarget } from "./state/useKinWork";
import { KinEmbedView } from "./widgets/KinEmbedView";
import { KinWatchLine } from "./KinWatchLine";

export type KinDocParams = {
  readonly environmentId: string;
  readonly orgId: string;
  /** The doc's short handle, such as `D-3`. */
  readonly doc: string;
  /** The section to arrive at. */
  readonly section?: string;
  /** An earlier version to read; the latest otherwise. */
  readonly v?: string;
  /** The version that was latest before a restore, which restoring again undoes. */
  readonly undo?: string;
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

/**
 * Where an image in a sentence loads from: a doc's own file through a URL the host mints for its
 * reader, and nothing for any other. An image on a line of its own is drawn by `renderImage`.
 */
function useKinDocImageSource(environmentId: EnvironmentId): MarkdownImageSourceResolver {
  const connection = usePreparedConnection(environmentId);
  const httpBaseUrl = Option.isSome(connection) ? connection.value.httpBaseUrl : null;
  const createUrl = useAtomQueryRunner(assetEnvironment.createUrl, { reportFailure: false });
  return async (image) => {
    const attachmentId = kinDocFileId(image.href);
    if (attachmentId === null) return kinImageSource();
    if (httpBaseUrl === null) throw new Error("The doc's image is unavailable offline");
    const result = await createUrl({
      environmentId,
      input: { resource: { _tag: "attachment", attachmentId } },
    });
    if (result._tag !== "Success") throw new Error("Could not authorize the doc's image");
    const uri = resolveAssetUrl(httpBaseUrl, result.value.relativeUrl);
    if (uri === null) throw new Error("The doc's image URL is invalid");
    return { uri };
  };
}

/** Change is by hand for whoever may; else the owner level asks an agent and a teammate suggests. */
const sectionActions = (ownerLevel: boolean, byHand: boolean) => [
  { id: "ask", title: KIN_DOCS.ask, image: "questionmark.bubble" },
  {
    id: "change",
    title: kinDocChangeItem({ byHand, ownerLevel }).label,
    image: "pencil",
  },
  { id: "link", title: KIN_DOCS.copyLink, image: "link" },
  { id: "copy", title: KIN_DOCS.copyText, image: "doc.on.doc" },
];

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
      undo={kinDocVersionParam(route.params.undo)}
    />
  );
}

type DocTarget = KinWorkTarget & {
  readonly docKey: KinRecordKey;
  readonly version: number | null;
  readonly section: string | null;
  readonly undo: number | null;
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
          action={<Button tone="secondary" label={KIN_RETRY} onPress={refresh} />}
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
      setProblem(KIN_DOCS.restoreOffline);
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
      Alert.alert(`Restore version ${version}?`, KIN_DOCS.restoreDetail(version), [
        { text: "Cancel", style: "cancel" },
        {
          text: "Restore",
          onPress: () =>
            void run(version, latest).then((doc) => {
              if (doc !== null) then(doc);
            }),
        },
      ]),
  };
}

/**
 * One section changed by hand: it saves against the section as opened (`kinDocEditOpen`), however
 * the doc refreshes meanwhile, and its typed text is kept on any refusal.
 */
function useKinDocEdit(target: KinWorkTarget, onSaved: () => void) {
  const { environmentId, orgId } = target;
  const send = useAtomCommand(kinClient.docEditSection, { reportFailure: false });
  const [editing, setEditing] = useState<{
    readonly opened: KinDocEditOpened;
    readonly text: string;
    readonly requestId: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState<number | null>(null);
  const save = async () => {
    if (editing === null || busy) return;
    if (!kinHostConnected(environmentId)) return setProblem(KIN_DOCS.editOffline);
    const input = kinDocEditInput(orgId, editing.opened, editing.text, editing.requestId);
    setBusy(true);
    setProblem(null);
    const outcome = kinDocEditOutcome(await send({ environmentId, input }));
    setBusy(false);
    if (outcome._tag === "refused") return setProblem(outcome.text);
    setEditing(null);
    setSaved(outcome.doc.version.version);
    onSaved();
  };
  const close = () => {
    setEditing(null);
    setProblem(null);
  };
  return {
    editing,
    busy,
    problem,
    saved,
    dismissSaved: () => setSaved(null),
    start: (doc: KinDocDetail, section: string) => {
      const opened = kinDocEditOpen(doc, section);
      if (opened === null) return;
      setSaved(null);
      setProblem(null);
      setEditing({ opened, text: opened.was, requestId: uuidv4() });
    },
    type: (text: string) => setEditing((held) => (held === null ? held : { ...held, text })),
    save,
    cancel: () => {
      if (editing === null || editing.text === editing.opened.was) return close();
      Alert.alert(KIN_DOCS.discard.title, undefined, [
        { text: KIN_DOCS.discard.keep, style: "cancel" },
        { text: KIN_DOCS.discard.confirm, style: "destructive", onPress: close },
      ]);
    },
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
  const openRecord = useKinWorkLink();
  const openLinked = useKinOpenLinked(props);
  const { environmentId, orgId, doc } = props;
  const { party, project } = doc;
  const target = { environmentId, orgId };
  const { names } = useKinWorkDirectory(target, true);
  const inbox = useKinInbox();
  const now = new Date(useNowMinuteMs());
  const styles = useMarkdownPreviewStyles();
  const openLink = useOpenPullRequest();
  const restore = useKinDocRestore(target, doc.key);
  const edit = useKinDocEdit(target, props.onRefresh);
  const canRender = useAtomValue(kinClient.docRender.permissionAtom(environmentId));
  const render = useAtomCommand(kinClient.docRender, { reportFailure: false });
  const [making, setMaking] = useState(false);
  const scroll = useRef<ComponentRef<typeof ScreenScrollView>>(null);
  // On iOS the page scrolls under the bar, so a section's top sits that far down the screen.
  const bar = useContentTopInset();
  const offsets = useRef(new Map<string, number>());
  const arrived = useRef(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [preview, setPreview] = useState<FilePreviewSource | null>(null);
  const resolveImageSource = useKinDocImageSource(environmentId);
  const undo = props.undo !== null && props.undo < doc.latest.version ? props.undo : null;

  const sections = kinDocSections(doc.body, doc.outline);
  // By hand only where the sections are cut as the host cuts them.
  const byHand = kinDocCanEdit(doc) && sections !== null;
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
  const label = useKinDocLabel(target, doc);
  const deleting = useKinDocDelete(target);
  const mayDelete = deleting.allowed && doc.deletable === true;
  const canFile = useAtomValue(kinClient.docFile.permissionAtom(environmentId));
  const fileIt = () => navigation.navigate("KinDocFile", { environmentId, orgId, doc: doc.key });
  const kind = kinDocKindOf(doc);
  const chats = inbox.state._tag === "ready" ? inbox.state.inbox.value.chats : [];
  const ownerLevel = useKinIsOwnerLevel(environmentId);
  const leads = useAtomValue(kinClient.leads({ environmentId, input: { orgId } }));
  const held = Option.getOrNull(AsyncResult.value(leads));
  // A teammate who doesn't chat with the doc's agent suggests through the team agent.
  const teamChat = ownerLevel
    ? null
    : (held?.contacts?.find((contact) => contact.agentId === held.teamAgentId)?.chatId ?? null);
  const chatId = kinDocChat(chats, doc, names.me)?.chatId ?? teamChat;
  const first = doc.outline.find((section) => section.id !== "top");
  const titled =
    doc.outline[0]?.id !== "top" &&
    first?.level === 1 &&
    first.title.trim().toLowerCase() === doc.title.toLowerCase();

  const point = (section: string | null, asked: KinDocAsk) => {
    if (chatId === null) {
      Alert.alert("Nobody to ask yet", KIN_DOCS.noAgent);
      return;
    }
    const ref = kinDocRef(doc, section);
    const intent = ownerLevel || asked === "ask" ? asked : "suggest";
    appAtomRegistry.set(kinPendingRefAtom(kinPendingRefKey(environmentId, chatId)), {
      ref,
      intent,
    });
    if (intent === "suggest") {
      const key = kinDraftKey(environmentId, orgId, chatId);
      if (getComposerDraftSnapshot(key).text.trim() === "")
        setComposerDraftText(key, kinDocSuggestStarter(ref));
    }
    navigation.navigate("KinChat", { environmentId, orgId, chatId });
  };
  const copyLink = async (section: string | null) => {
    const url = Linking.createURL(`kin/${environmentId}/${orgId}/docs/${doc.key}`, {
      queryParams: section === null ? {} : { section },
    });
    if (await tryCopyTextWithHaptic(url, { target: "link" })) setCopied(KIN_DOCS.copied);
  };
  const copyText = async (markdown: string) => {
    if (await tryCopyTextWithHaptic(kinDocCopyText(markdown), { target: "text" }))
      setCopied(KIN_DOCS.textCopied);
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
  const exportPdf = async () => {
    const input = kinDocPdfInput(orgId, doc, uuidv4());
    if (input === null || making) return;
    setMaking(true);
    const result = await render({ environmentId, input });
    setMaking(false);
    const made = AsyncResult.isSuccess(result) ? result.value.documents[0] : undefined;
    if (made === undefined)
      return Alert.alert(
        kinFailureText(
          AsyncResult.isFailure(result) ? squashAtomCommandFailure(result) : null,
          KIN_DOCS.exportPdfFailed,
        ),
      );
    openRecord("KinDoc", { environmentId, orgId, doc: made.key });
  };
  const jump = (id: string) => {
    const y = id === "top" ? 0 : offsets.current.get(id);
    if (y !== undefined) scroll.current?.scrollTo({ y: y - bar, animated: true });
  };
  const act = (section: string | null, text: string, action: string) => {
    if (action === "change" && byHand && section !== null) edit.start(doc, section);
    else if (action === "ask" || action === "change") point(section, action);
    else if (action === "link") void copyLink(section);
    else if (action === "copy") void copyText(text);
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
      // The few used in the day first; the rest fold under More.
      items: [
        ...(doc.body.trim() === ""
          ? []
          : [{ id: "copy", title: KIN_DOCS.copyText, onPress: () => void copyText(doc.body) }]),
        byHand && sections.length > 1
          ? {
              id: "change",
              title: KIN_DOCS.change,
              items: sections.map((one) => ({
                id: `change:${one.id}`,
                title: one.title,
                onPress: () => {
                  jump(one.id);
                  edit.start(doc, one.id);
                },
              })),
            }
          : {
              id: "change",
              title: kinDocChangeItem({ byHand, ownerLevel }).label,
              onPress: () =>
                byHand && sections[0] !== undefined
                  ? edit.start(doc, sections[0].id)
                  : point(null, "change"),
            },
        { id: "ask", title: KIN_DOCS.ask, onPress: () => point(null, "ask") },
        ...(canRender && kinDocPdfInput(orgId, doc, "pdf") !== null
          ? [
              {
                id: "pdf",
                title: making ? KIN_DOCS.exportingPdf : KIN_DOCS.sharePdf,
                onPress: () => void exportPdf(),
              },
            ]
          : []),
        {
          id: "more",
          title: KIN_DOCS.more,
          items: [
            {
              id: "history",
              title: KIN_DOCS.history,
              onPress: () =>
                navigation.navigate("KinDocHistory", { environmentId, orgId, doc: doc.key }),
            },
            { id: "link", title: KIN_DOCS.copyLink, onPress: () => void copyLink(null) },
            { id: "export", title: KIN_DOCS.export, onPress: () => void share() },
            ...(canFile ? [{ id: "file", title: KIN_DOC_HOMES.fileTitle, onPress: fileIt }] : []),
            ...(label.action === null
              ? []
              : [{ id: "label", title: label.action.label, onPress: label.ask }]),
            ...(mayDelete && !doc.archived && deleting.busy === null
              ? [
                  {
                    id: "delete",
                    title: KIN_DOCS.delete,
                    destructive: true,
                    onPress: () =>
                      void deleting.remove(doc.key).then((done) => done && props.onRefresh()),
                  },
                ]
              : []),
          ],
        },
      ],
    },
  ];

  const editor =
    edit.editing === null ? null : (
      <View className="mb-3 gap-2">
        <TextInput
          accessibilityLabel={KIN_DOCS.editing(edit.editing.opened.title)}
          value={edit.editing.text}
          editable={!edit.busy}
          multiline
          autoFocus
          onChangeText={edit.type}
          textAlignVertical="top"
          placeholderTextColorClassName="accent-placeholder"
          className="min-h-32 rounded-lg border border-border px-3 py-2 font-sans text-base text-foreground"
        />
        {edit.problem === null ? null : <Notice tone="danger" message={edit.problem} />}
        <View className="flex-row gap-2">
          <Button
            tone="primary"
            size="compact"
            label={edit.busy ? KIN_DOCS.saving : KIN_DOCS.save}
            loading={edit.busy}
            disabled={edit.busy || edit.editing.text === edit.editing.opened.was}
            onPress={() => void edit.save()}
          />
          <Button
            tone="secondary"
            size="compact"
            label={KIN_DOCS.cancel}
            disabled={edit.busy}
            onPress={edit.cancel}
          />
        </View>
      </View>
    );
  // A draft whose section no longer reads as opened is kept, above the doc.
  const editorAside =
    edit.editing !== null &&
    !(sections ?? []).some((one) => one.id === edit.editing?.opened.section);

  const renderImage: MarkdownImageRenderer = (image) => {
    const attachmentId = kinDocFileId(image.href);
    return attachmentId === null ? (
      renderImageAsText(image)
    ) : (
      <ThreadMarkdownImage
        environmentId={environmentId}
        resource={{ _tag: "attachment", attachmentId }}
        alt={image.alt}
        onPressPreview={setPreview}
      />
    );
  };
  /** Text under a long press for `menu`'s actions; a drawn block sits outside it, as a chat card does. */
  const content = (text: string, menu: (children: ReactNode) => ReactNode) =>
    kinDocPieces(text, doc).map((piece, index) => (
      <Fragment key={kinDocPieceKey(piece, index)}>
        {piece.type === "text" ? (
          menu(
            <View>
              <SelectableMarkdownText
                markdown={kinDocMarkdown(piece.text)}
                textStyle={styles.nativeTextStyle}
                // A long press opens the section's own actions, which include copying its text.
                selectable={false}
                inlineWebLinks
                onLinkPress={onLinkPress}
                renderImage={renderImage}
                resolveImageSource={resolveImageSource}
              />
            </View>,
          )
        ) : (
          <View className="mb-3">
            <KinEmbedView environmentId={environmentId} orgId={orgId} embed={piece.embed} />
          </View>
        )}
      </Fragment>
    ));

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
            {
              <View className="flex-row flex-wrap gap-2">
                <Chip
                  size="small"
                  icon="doc.text"
                  label={KIN_DOC_KIND_LABELS[kind].one}
                  accessibilityLabel={`${KIN_DOC_HOMES.kind}: ${KIN_DOC_KIND_LABELS[kind].one}`}
                  {...(canFile ? { onPress: fileIt } : {})}
                />
                {doc.company === true ? (
                  <Chip
                    size="small"
                    icon="folder.fill"
                    label={KIN_DOC_HOMES.company}
                    {...(canFile ? { onPress: fileIt } : {})}
                  />
                ) : null}
                {kinDocUnfiled(doc) ? (
                  <Chip
                    size="small"
                    icon="tray.and.arrow.down"
                    label={
                      canFile
                        ? `${KIN_DOC_HOMES.unfiled} · ${KIN_DOC_HOMES.file}`
                        : KIN_DOC_HOMES.unfiled
                    }
                    {...(canFile ? { onPress: fileIt } : {})}
                  />
                ) : null}
                {party === undefined ? null : (
                  <Chip
                    size="small"
                    icon="person.2"
                    label={party.title}
                    accessibilityLabel={`Open ${party.title}`}
                    onPress={() =>
                      openRecord("KinClient", { environmentId, orgId, party: party.key })
                    }
                  />
                )}
                {project === undefined ? null : (
                  <Chip
                    size="small"
                    icon="folder"
                    label={project.title}
                    accessibilityLabel={`Open ${project.title}`}
                    onPress={() =>
                      openRecord("KinProject", { environmentId, orgId, project: project.key })
                    }
                  />
                )}
              </View>
            }
            {doc.archived ||
            doc.sensitive ||
            doc.sensitiveInherited === true ? null : doc.company === true ? (
              <ListSection title={KIN_DOC_COMPANY.label}>
                <View className="px-4 py-3">
                  <Text textRole="body" className="text-foreground-muted">
                    {KIN_DOC_COMPANY.note}
                  </Text>
                </View>
              </ListSection>
            ) : (
              <ListSection>
                <KinWorkShareRow
                  environmentId={environmentId}
                  orgId={orgId}
                  itemKey={doc.key}
                  shared={doc.shared === true}
                  disabled={false}
                  copy={KIN_DOC_SHARE}
                  onSettled={props.onRefresh}
                />
              </ListSection>
            )}
            <KinWatchLine {...target} recordKey={doc.key} />
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
            {label.problem === null ? null : (
              <Notice tone="danger" message={label.problem} onDismiss={label.dismiss} />
            )}
            {deleting.problem === null ? null : (
              <Notice tone="danger" message={deleting.problem} onDismiss={deleting.dismiss} />
            )}
            {!doc.archived ? null : (
              <Notice
                message={
                  deleting.justDeleted === doc.key
                    ? KIN_DOCS.deletedNotice(doc.title)
                    : doc.deleted === undefined
                      ? KIN_DOCS.deletedBanner
                      : `${kinDocDeletedLine(doc.deleted, names, now)}. ${KIN_DOCS.deletedBanner}`
                }
                {...(mayDelete
                  ? {
                      action: {
                        label:
                          deleting.justDeleted === doc.key ? KIN_DOCS.undo : KIN_DOCS.restoreDoc,
                        pending: deleting.busy !== null,
                        onPress: () =>
                          void deleting.restore(doc.key).then((done) => done && props.onRefresh()),
                      },
                    }
                  : {})}
              />
            )}
            {props.stale ? <Notice message="Offline. Showing the last copy read." /> : null}
            {restore.problem === null ? null : (
              <Notice tone="danger" message={restore.problem} onDismiss={restore.dismiss} />
            )}
            {edit.saved === null ? null : (
              <Notice message={KIN_DOCS.saved(edit.saved)} onDismiss={edit.dismissSaved} />
            )}
            {copied === null ? null : <Notice message={copied} onDismiss={() => setCopied(null)} />}
            {undo === null ? null : (
              <Notice
                message={KIN_DOCS.restored(doc.latest.version)}
                action={{
                  label: "Undo",
                  pending: restore.busy,
                  onPress: () =>
                    void restore.run(undo, doc.latest.version).then((restored) => {
                      if (restored === null) return;
                      navigation.setParams({ undo: undefined });
                      props.onRefresh();
                    }),
                }}
              />
            )}
            {old ? (
              <View className="gap-2">
                <Notice
                  message={KIN_DOCS.oldVersion(doc.version.version, doc.latest.version)}
                  action={{
                    label: KIN_DOCS.openLatest,
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
                      restore.confirm(doc.version.version, doc.latest.version, () =>
                        navigation.setParams({ v: undefined, undo: String(doc.latest.version) }),
                      )
                    }
                  />
                ) : null}
              </View>
            ) : null}
          </View>
          {editorAside ? editor : null}
          {doc.version.file === undefined ? null : (
            <KinDocFileRows environmentId={environmentId} file={doc.version.file} />
          )}
          {doc.body.trim() === "" ? (
            doc.version.file === undefined ? (
              <Text textRole="body" className="text-foreground-muted">
                {KIN_DOCS.noText}
              </Text>
            ) : null
          ) : sections === null ? (
            content(doc.body, (children) => (
              <Menu
                shouldOpenOnLongPress
                actions={sectionActions(ownerLevel, false)}
                onPressAction={({ nativeEvent }) => act(null, doc.body, nativeEvent.event)}
              >
                {children}
              </Menu>
            ))
          ) : (
            sections.map((section) => (
              <View
                key={section.id}
                onLayout={(event) => {
                  offsets.current.set(section.id, event.nativeEvent.layout.y);
                  // Arriving from a link or a search hit, the page opens at its section.
                  if (section.id === props.section && !arrived.current) {
                    arrived.current = true;
                    scroll.current?.scrollTo({
                      y: event.nativeEvent.layout.y - bar,
                      animated: false,
                    });
                  }
                }}
              >
                {edit.editing?.opened.section === section.id
                  ? editor
                  : content(section.text, (children) => (
                      <Menu
                        title={section.title}
                        shouldOpenOnLongPress
                        accessibilityLabel={`${section.title}. Hold for actions`}
                        actions={sectionActions(ownerLevel, byHand)}
                        onPressAction={({ nativeEvent }) =>
                          act(section.id, section.text, nativeEvent.event)
                        }
                      >
                        {children}
                      </Menu>
                    ))}
              </View>
            ))
          )}
          <View className="pt-3">
            {/* The chips above name the doc's client and project already. */}
            <KinLinkedSection item={doc} parentsShown onOpen={openLinked} />
          </View>
        </ScreenScrollView>
      </ScreenContent>
      <FilePreviewModal source={preview} onRequestClose={() => setPreview(null)} />
    </View>
  );
}
