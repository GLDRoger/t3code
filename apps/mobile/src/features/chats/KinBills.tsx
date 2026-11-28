import { LegendList } from "@legendapp/list/react-native";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  KIN_CHECK_CONNECTION,
  KIN_RETRY,
  kinFailure,
} from "@t3tools/client-runtime/kin/kinAnswers";
import {
  KIN_BILLS,
  kinBillBatchSentence,
  kinBillExpenseStart,
  kinBillFileRefusal,
  kinBillFixStart,
  kinBillName,
  kinBillReviewCounts,
  kinBillRowViews,
  kinBillsCanKeepAll,
  kinBillsUnreadAgain,
  type KinBillAction,
  type KinBillField,
  type KinBillRowView,
  type KinBillTone,
} from "@t3tools/client-runtime/kin/kinBills";
import { kinCategoryLabel } from "@t3tools/client-runtime/kin/kinLists";
import { KIN_CHAT_PHOTO_MAX_EDGE } from "@t3tools/client-runtime/kin/kinPhotoFit";
import {
  EnvironmentId,
  KIN_DEFAULT_HOME_CURRENCY,
  KinOrgId,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
} from "@t3tools/contracts";
import { clampFileAttachmentUploadBytes } from "@t3tools/client-runtime/state/attachments";
import { Image as ExpoImage } from "expo-image";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { memo, useEffect, useRef, useState } from "react";
import { Pressable, useWindowDimensions, View } from "react-native";

import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { AppBar } from "../../components/ui/AppBar";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { FilePreviewModal, type FilePreviewSource } from "../../components/ui/FilePreviewModal";
import { ListRow } from "../../components/ui/ListRow";
import { ListSection } from "../../components/ui/ListSection";
import { Notice } from "../../components/ui/Notice";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { assetImageSource } from "../../lib/assetImageSource";
import { useNowMinuteMs } from "../../lib/clock";
import {
  convertPastedImagesToAttachments,
  createComposerFileAttachment,
} from "../../lib/composerImages";
import { useAssetUrl } from "../../state/assets";
import { KinAddressSentence } from "./components/KinSenderAddress";
import { KinWorkFrame, KinWorkLoading } from "./components/KinWorkPieces";
import { forgetKinSharedFile } from "./kinSharedFileInbox";
import type { KinSharedFile } from "./state/kinSharedFile";
import { kinBillFixParamsOf, kinExpenseParamsOfBill } from "./state/kinBillsPick";
import { useKinHomeCurrency, useKinLists, kinListsOf } from "./state/useKinMoney";
import {
  useKinBillActions,
  useKinBillBatch,
  useKinBillBatches,
  useKinBillReader,
} from "./state/useKinBills";
import { useKinOpenBillsChat } from "./state/useKinOpenChat";
import type { KinWorkTarget } from "./state/useKinWork";

export type KinBillsAddParams = {
  readonly environmentId: string;
  readonly orgId: string;
  /** A file shared into Kin from another app (`kinSharedFileInbox`), picked as if picked here. */
  readonly file?: string;
  readonly fileName?: string;
  readonly fileType?: string;
};
export type KinBillsParams = {
  readonly environmentId: string;
  readonly orgId: string;
  /** One batch's list; left out, every batch. */
  readonly batch?: string;
};

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeOrgId = Schema.decodeUnknownOption(KinOrgId);
const targetOf = (params: KinBillsAddParams): KinWorkTarget | null => {
  const environmentId = Option.getOrNull(decodeEnvironmentId(params.environmentId));
  const orgId = Option.getOrNull(decodeOrgId(params.orgId));
  return environmentId === null || orgId === null ? null : { environmentId, orgId };
};

/**
 * A photo or PDF shared into Kin from another app: it goes in the box of the chat bills are added
 * in, as a picked one would, with "Bills to add" ready to send. The old Add bills screen is gone.
 */
export function KinBillsAddScreen({ route }: StaticScreenProps<KinBillsAddParams>) {
  const navigation = useNavigation();
  const target = targetOf(route.params);
  if (target === null)
    return (
      <KinWorkFrame title={KIN_BILLS.title} onClose={() => navigation.goBack()}>
        <EmptyState variant="plain" {...KIN_BILLS.gone} />
      </KinWorkFrame>
    );
  const { file, fileName, fileType } = route.params;
  const shared =
    file === undefined
      ? null
      : { uri: file, name: fileName ?? "file", mimeType: fileType ?? "application/octet-stream" };
  return <OpenBillsChat {...target} shared={shared} />;
}

/** A shared file as the chat's own picker hands one over; the system's copy goes once Kin holds its own. */
async function sharedAttachment(shared: KinSharedFile) {
  try {
    const refused = kinBillFileRefusal(shared);
    if (refused !== null) return { attachment: null, error: refused };
    if (shared.mimeType.startsWith("image/")) {
      const { attachments, error } = await convertPastedImagesToAttachments({
        uris: [shared.uri],
        maxEdge: KIN_CHAT_PHOTO_MAX_EDGE,
      });
      const [photo] = attachments;
      return photo === undefined
        ? { attachment: null, error: error ?? KIN_BILLS.uploadFailed }
        : { attachment: { ...photo, name: shared.name }, error: null };
    }
    const attachment = await createComposerFileAttachment({
      uri: shared.uri,
      name: shared.name,
      mimeType: shared.mimeType,
      sizeBytes: null,
      maxBytes: clampFileAttachmentUploadBytes(PROVIDER_SEND_TURN_MAX_FILE_BYTES),
    });
    return { attachment, error: null };
  } catch (cause) {
    return {
      attachment: null,
      error: cause instanceof Error ? cause.message : KIN_BILLS.uploadFailed,
    };
  } finally {
    await forgetKinSharedFile(shared.uri);
  }
}

function OpenBillsChat(props: KinWorkTarget & { readonly shared: KinSharedFile | null }) {
  const navigation = useNavigation();
  const reader = useKinBillReader(props);
  const openBills = useKinOpenBillsChat();
  const [failed, setFailed] = useState<string | null>(null);
  const opened = useRef(false);
  const { environmentId, orgId, shared } = props;
  const problem = reader === null ? KIN_BILLS.noReader : failed;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the file another app shared into Kin from disk once the agents are known, then leaves for that agent's chat
  useEffect(() => {
    if (reader == null || opened.current) return;
    opened.current = true;
    void (async () => {
      const taken = shared === null ? null : await sharedAttachment(shared);
      if (taken !== null && taken.attachment === null) return setFailed(taken.error);
      const refused = await openBills(environmentId, orgId, reader.agentId, {
        replace: true,
        ...(taken?.attachment == null ? {} : { attachments: [taken.attachment] }),
      });
      if (refused !== null) setFailed(refused);
    })();
  }, [reader, shared, environmentId, orgId, openBills]);
  return (
    <KinWorkFrame title={KIN_BILLS.title} onClose={() => navigation.goBack()}>
      {problem === null ? (
        <KinWorkLoading label="Opening the chat" />
      ) : (
        <Notice message={problem} tone="danger" />
      )}
    </KinWorkFrame>
  );
}

/** Bills added in bulk: every batch, newest first, or one batch's list to review. */
export function KinBillsScreen({ route }: StaticScreenProps<KinBillsParams>) {
  const navigation = useNavigation();
  const target = targetOf(route.params);
  if (target === null)
    return (
      <Frame title={KIN_BILLS.added} onBack={() => navigation.goBack()}>
        <EmptyState variant="plain" {...KIN_BILLS.gone} />
      </Frame>
    );
  const batch = route.params.batch;
  return batch === undefined || batch === "" ? (
    <Batches {...target} />
  ) : (
    <Review key={batch} {...target} batchId={batch} />
  );
}

function Frame(props: {
  readonly title: string;
  readonly onBack: () => void;
  readonly onRefresh?: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar
        title={props.title}
        onBack={props.onBack}
        {...(props.onRefresh === undefined
          ? {}
          : { refresh: { accessibilityLabel: "Refresh", onPress: props.onRefresh } })}
      />
      <ScreenContent surface="screen">{props.children}</ScreenContent>
    </View>
  );
}

function Failed(props: { readonly cause: unknown; readonly onRetry: () => void }) {
  const failure = kinFailure(props.cause, `${KIN_BILLS.loadFailed}.`);
  return (
    <EmptyState
      variant="plain"
      title={KIN_BILLS.loadFailed}
      detail={failure.retry ? KIN_CHECK_CONNECTION : failure.text}
      {...(failure.retry
        ? { action: <Button tone="secondary" label={KIN_RETRY} onPress={props.onRetry} /> }
        : {})}
    />
  );
}

function Batches(props: KinWorkTarget) {
  const navigation = useNavigation();
  const { state, refresh } = useKinBillBatches(props);
  const now = new Date(useNowMinuteMs());
  const back = () => navigation.goBack();
  const open = (batch: string) =>
    navigation.dispatch(
      StackActions.push("KinBills", {
        environmentId: String(props.environmentId),
        orgId: String(props.orgId),
        batch,
      }),
    );
  return (
    <Frame title={KIN_BILLS.added} onBack={back} onRefresh={refresh}>
      {state._tag === "refused" ? (
        <EmptyState variant="plain" {...KIN_BILLS.onlyOwner} />
      ) : state._tag === "loading" ? (
        <KinWorkLoading label="Loading bills" />
      ) : state._tag !== "ready" ? (
        <Failed cause={state._tag === "failed" ? state.cause : null} onRetry={refresh} />
      ) : state.value.batches.length === 0 ? (
        <EmptyState variant="plain" {...KIN_BILLS.none} />
      ) : (
        <NativeScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ padding: 16, paddingBottom: 48 }}
        >
          <ListSection>
            {state.value.batches.map((batch) => (
              <ListRow
                key={batch.batchId}
                label={KIN_BILLS.batchTitle(batch.addedAt, now)}
                description={kinBillBatchSentence(batch.states, batch.bills)}
                onPress={() => open(batch.batchId)}
              />
            ))}
          </ListSection>
        </NativeScrollView>
      )}
    </Frame>
  );
}

function Review(props: KinWorkTarget & { readonly batchId: string }) {
  const navigation = useNavigation();
  const { environmentId, orgId } = props;
  const { state, rows, batch, refresh } = useKinBillBatch(props, props.batchId);
  const actions = useKinBillActions(props, props.batchId, refresh);
  const lists = useKinLists(props, { enabled: true });
  const expenses = kinListsOf(lists).find((one) => one.list === "expenses") ?? null;
  const home = useKinHomeCurrency(props) ?? KIN_DEFAULT_HOME_CURRENCY;
  const now = new Date(useNowMinuteMs());
  const [preview, setPreview] = useState<FilePreviewSource | null>(null);
  const skipped = actions.kept?.skipped;
  const views = kinBillRowViews(rows, {
    categoryLabel: (category) => kinCategoryLabel(category, expenses),
    ...(skipped === undefined ? {} : { skipped }),
  });
  const base = { environmentId: String(environmentId), orgId: String(orgId) };
  const openKey = (task: string) => navigation.navigate("KinWorkItem", { ...base, task });
  const run = (view: KinBillRowView, action: KinBillAction) => {
    switch (action) {
      case "keep":
      case "drop":
      case "addAnyway":
      case "dismiss":
      case "readAgain":
        return void actions.act(view, action);
      case "edit":
      case "openExpense":
        return view.expense === null ? undefined : openKey(view.expense.key);
      case "openDuplicate":
        return view.duplicateOf === null ? undefined : openKey(view.duplicateOf);
      case "byHand":
        return navigation.navigate(
          "KinExpenseNew",
          kinExpenseParamsOfBill(
            base,
            kinBillExpenseStart(view.row, home, expenses?.categories ?? []),
            kinBillName(view.row),
          ),
        );
      case "fix":
        return navigation.navigate(
          "KinBillFix",
          kinBillFixParamsOf(
            base,
            { sha256: view.row.sha256, name: kinBillName(view.row) },
            kinBillFixStart(view.row, home, expenses?.categories ?? []),
          ),
        );
    }
  };
  const title = batch === null ? KIN_BILLS.added : KIN_BILLS.batchTitle(batch.addedAt, now);
  const back = () => navigation.goBack();
  if (state._tag !== "ready")
    return (
      <Frame title={title} onBack={back} onRefresh={refresh}>
        {state._tag === "refused" ? (
          <EmptyState variant="plain" {...KIN_BILLS.onlyOwner} />
        ) : state._tag === "gone" ? (
          <EmptyState variant="plain" {...KIN_BILLS.gone} />
        ) : state._tag === "loading" ? (
          <KinWorkLoading label="Loading bills" />
        ) : (
          <Failed cause={state.cause} onRetry={refresh} />
        )}
      </Frame>
    );
  const counts = kinBillReviewCounts(batch?.states ?? null, rows);
  const canKeepAll = actions.allowed && kinBillsCanKeepAll(counts);
  const unread = kinBillsUnreadAgain(views);
  return (
    <Frame title={title} onBack={back} onRefresh={refresh}>
      <LegendList<KinBillRowView>
        renderScrollComponent={NativeScrollView}
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingBottom: 48 }}
        data={views}
        keyExtractor={(view) => view.key}
        extraData={actions}
        estimatedItemSize={196}
        recycleItems
        ListEmptyComponent={<EmptyState variant="plain" {...KIN_BILLS.allDismissed} />}
        ListHeaderComponent={
          <View className="gap-3 px-4 pb-2 pt-3">
            <Text textRole="body" className="text-foreground">
              {kinBillBatchSentence(counts, batch?.bills ?? rows.length)}
            </Text>
            {actions.allowed ? (
              <Button
                tone="secondary"
                label={KIN_BILLS.keepAll}
                disabled={!canKeepAll || actions.busy !== null}
                loading={actions.busy === "all"}
                onPress={() => void actions.keepAll()}
              />
            ) : null}
            {actions.allowed && unread.length > 0 ? (
              <Button
                tone="secondary"
                label={KIN_BILLS.readUnreadAgain(unread.length)}
                disabled={actions.busy !== null}
                loading={actions.busy === "again"}
                onPress={() => void actions.readUnreadAgain(unread)}
              />
            ) : null}
            {actions.kept === null ? null : (
              <Text
                textRole="footnote"
                accessibilityLiveRegion="polite"
                className="text-foreground"
              >
                {actions.kept.said}
              </Text>
            )}
            {actions.problem?.key === "all" ? (
              <Notice message={actions.problem.text} tone="danger" />
            ) : null}
          </View>
        }
        renderItem={({ item }) => (
          <BillRow
            view={item}
            environmentId={environmentId}
            canChange={actions.allowed}
            busy={actions.busy !== null}
            problem={actions.problem?.key === item.key ? actions.problem.text : null}
            onAction={run}
            onPreview={setPreview}
          />
        )}
      />
      <FilePreviewModal source={preview} onRequestClose={() => setPreview(null)} />
    </Frame>
  );
}

const TONE: Record<KinBillTone, string> = {
  muted: "text-foreground-muted",
  active: "text-foreground",
  attention: "text-warning-foreground",
  // The phone's themes have no success colour; an unknown class draws black, unreadable in dark.
  done: "text-foreground-secondary",
};
// From this text size a field's label goes above its value, so neither breaks mid-word.
const LARGE_TEXT_SCALE = 1.5;
const WHOLE_FIELDS: ReadonlySet<KinBillField["key"]> = new Set(["number", "amount"]);
const wordCount = (text: string | null) => Math.max(1, (text ?? "").trim().split(/\s+/).length);

const CHANGES: ReadonlySet<KinBillAction> = new Set([
  "keep",
  "drop",
  "addAnyway",
  "dismiss",
  "byHand",
  "readAgain",
  "edit",
  "fix",
]);

const label = (view: KinBillRowView, action: KinBillAction) =>
  action === "openDuplicate"
    ? KIN_BILLS.open(view.duplicateOf ?? "")
    : action === "openExpense"
      ? KIN_BILLS.open(view.expense?.key ?? "")
      : KIN_BILLS.action[action];

/** A bill's file at a fixed size: a photo from the host's signed address, a PDF as its tile. */
function BillThumb(props: {
  readonly view: KinBillRowView;
  readonly environmentId: EnvironmentId;
  readonly onPreview: (source: FilePreviewSource) => void;
}) {
  const { file, picture, pdf, asFile } = props.view;
  const name = kinBillName(props.view.row);
  const resource = {
    _tag: "attachment" as const,
    attachmentId: file.attachmentId,
    fileName: file.name,
    mimeType: pdf ? "application/pdf" : file.mimeType,
  };
  const shown = {
    _tag: "attachment" as const,
    attachmentId: picture.attachmentId,
    fileName: picture.name,
    mimeType: picture.mimeType,
  };
  // A file opens from the host when tapped; a photo draws its smaller copy and opens the original.
  const uri = useAssetUrl(props.environmentId, asFile ? null : shown);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${name}`}
      onPress={() =>
        props.onPreview({
          kind: pdf ? "pdf" : asFile ? "document" : "image",
          name,
          mimeType: resource.mimeType,
          environmentId: props.environmentId,
          resource,
        })
      }
      className="size-16 items-center justify-center overflow-hidden rounded-xl border border-border bg-subtle-strong active:opacity-70"
    >
      {asFile ? (
        <SymbolView name="doc.text" size={22} tintColorClassName="accent-icon-muted" />
      ) : uri === null ? null : (
        <ExpoImage
          source={assetImageSource(props.environmentId, shown, uri)}
          style={{ width: 64, height: 64 }}
          contentFit="cover"
          contentPosition="top"
          recyclingKey={picture.attachmentId}
          accessibilityIgnoresInvertColors
        />
      )}
    </Pressable>
  );
}

/** One bill: its file, what was read in fixed places, its state and its taps. */
const BillRow = memo(function BillRow(props: {
  readonly view: KinBillRowView;
  readonly environmentId: EnvironmentId;
  readonly canChange: boolean;
  readonly busy: boolean;
  readonly problem: string | null;
  readonly onAction: (view: KinBillRowView, action: KinBillAction) => void;
  readonly onPreview: (source: FilePreviewSource) => void;
}) {
  const { view } = props;
  const taps = view.actions.filter((action) => props.canChange || !CHANGES.has(action));
  const note = view.problem ?? view.skipped;
  const stacked = useWindowDimensions().fontScale >= LARGE_TEXT_SCALE;
  return (
    <View accessible={false} className="flex-row gap-3 border-b border-border px-4 py-3">
      <BillThumb view={view} environmentId={props.environmentId} onPreview={props.onPreview} />
      <View className="flex-1 gap-1.5">
        <Text
          textRole="body"
          accessibilityLabel={view.accessibilityLabel}
          className={`font-t3-medium ${TONE[view.tone]}`}
        >
          {view.label}
        </Text>
        <View className="gap-0.5">
          {view.fields.map((field) => (
            <View key={field.key} className={stacked ? "min-h-4" : "min-h-4 flex-row gap-3"}>
              <Text
                textRole="footnote"
                className={stacked ? "text-foreground-muted" : "w-28 text-foreground-muted"}
              >
                {field.label}
              </Text>
              <Text
                textRole="footnote"
                {...(!stacked
                  ? { numberOfLines: 1 }
                  : WHOLE_FIELDS.has(field.key)
                    ? // A bill number or amount shrinks to fit rather than breaking mid-number.
                      { numberOfLines: wordCount(field.value), adjustsFontSizeToFit: true }
                    : {})}
                className={stacked ? "text-foreground" : "flex-1 text-foreground"}
              >
                {field.value ?? ""}
              </Text>
            </View>
          ))}
        </View>
        {view.currencyNote === null ? null : (
          <Text textRole="footnote" className="text-foreground-muted">
            {view.currencyNote}
          </Text>
        )}
        {view.mailLine === null ? null : (
          <KinAddressSentence
            text={view.mailLine}
            textRole="footnote"
            className="text-foreground-muted"
          />
        )}
        <Text textRole="footnote" className="min-h-4 text-foreground-muted">
          {note ?? ""}
        </Text>
        {props.problem === null ? null : (
          <Text
            textRole="footnote"
            accessibilityLiveRegion="polite"
            className="text-danger-foreground"
          >
            {props.problem}
          </Text>
        )}
        <View className="min-h-10 flex-row flex-wrap gap-2">
          {taps.map((action) => (
            <Button
              key={action}
              size="compact"
              tone={
                action === "keep" || action === "addAnyway" || action === "fix"
                  ? "secondary"
                  : "text"
              }
              label={label(view, action)}
              accessibilityLabel={`${label(view, action)}: ${view.name}`}
              disabled={props.busy && CHANGES.has(action)}
              onPress={() => props.onAction(view, action)}
            />
          ))}
        </View>
      </View>
    </View>
  );
});
