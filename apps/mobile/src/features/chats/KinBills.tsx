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
  kinBillCounts,
  kinBillExpenseStart,
  kinBillRowView,
  kinBillsButton,
  kinBillsCanKeepAll,
  kinBillsOutcome,
  kinBillUploadText,
  type KinBillAction,
  type KinBillRowView,
  type KinBillTone,
} from "@t3tools/client-runtime/kin/kinBills";
import { kinCategoryLabel } from "@t3tools/client-runtime/kin/kinLists";
import {
  EnvironmentId,
  KIN_DEFAULT_HOME_CURRENCY,
  KinOrgId,
  type KinAttachment,
} from "@t3tools/contracts";
import { Image as ExpoImage } from "expo-image";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { memo, useState } from "react";
import { Pressable, View } from "react-native";

import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { AppBar } from "../../components/ui/AppBar";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { FilePreviewModal, type FilePreviewSource } from "../../components/ui/FilePreviewModal";
import { IconButton } from "../../components/ui/IconButton";
import { ListRow } from "../../components/ui/ListRow";
import { ListSection } from "../../components/ui/ListSection";
import { Notice } from "../../components/ui/Notice";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { assetImageSource } from "../../lib/assetImageSource";
import { useNowMinuteMs } from "../../lib/clock";
import {
  convertPastedImagesToAttachments,
  pickComposerFiles,
  pickComposerMedia,
  type DraftComposerAttachment,
} from "../../lib/composerImages";
import { beginForegroundHandoff } from "../../lib/foreground-handoff";
import { useAssetUrl } from "../../state/assets";
import { uploadComposerAttachmentShared } from "../../state/composer-attachment-uploads";
import { KinWorkFrame, KinWorkLoading } from "./components/KinWorkPieces";
import { kinBillChoices, kinExpenseParamsOfBill } from "./state/kinBillsPick";
import { useKinHomeCurrency, useKinLists, kinListsOf } from "./state/useKinMoney";
import {
  useKinBillActions,
  useKinBillBatch,
  useKinBillBatches,
  useKinBillsAdd,
} from "./state/useKinBills";
import type { KinWorkTarget } from "./state/useKinWork";

export type KinBillsAddParams = { readonly environmentId: string; readonly orgId: string };
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

/** One bill's bytes through the composer's upload path; the host claims it on the add. */
async function uploadBill(
  environmentId: EnvironmentId,
  draft: DraftComposerAttachment,
  name: string,
): Promise<KinAttachment> {
  const id = await Effect.runPromise(uploadComposerAttachmentShared(environmentId, draft));
  const { mimeType, sizeBytes } = draft;
  return draft.type === "image"
    ? { type: "image", id, name, mimeType, sizeBytes }
    : { type: "file", id, name, mimeType, sizeBytes };
}

/** A photo of a bill from the camera, through the same path a pasted photo takes. */
async function takeBillPhoto(number: number) {
  const picker = await import("expo-image-picker");
  const allowed = await picker.requestCameraPermissionsAsync();
  if (!allowed.granted) return { photo: null, error: KIN_BILLS.cameraRefused };
  const endHandoff = beginForegroundHandoff();
  let taken: Awaited<ReturnType<typeof picker.launchCameraAsync>>;
  try {
    taken = await picker.launchCameraAsync({ mediaTypes: ["images"], quality: 1, base64: false });
  } finally {
    endHandoff();
  }
  const asset = taken.canceled ? undefined : taken.assets[0];
  if (asset === undefined) return { photo: null, error: null };
  const converted = await convertPastedImagesToAttachments({ uris: [asset.uri] });
  const [photo] = converted.attachments;
  if (photo === undefined) return { photo: null, error: converted.error };
  const extension = photo.mimeType === "image/png" ? "png" : "jpg";
  return { photo: { ...photo, name: `bill-photo-${number}.${extension}` }, error: null };
}

/** Money's Add › Bills on the phone: from the photo library, files or the camera, then one add. */
export function KinBillsAddScreen({ route }: StaticScreenProps<KinBillsAddParams>) {
  const navigation = useNavigation();
  const target = targetOf(route.params);
  if (target === null)
    return (
      <KinWorkFrame title={KIN_BILLS.title} onClose={() => navigation.goBack()}>
        <EmptyState variant="plain" {...KIN_BILLS.gone} />
      </KinWorkFrame>
    );
  return <AddBills {...target} />;
}

function AddBills(props: KinWorkTarget) {
  const navigation = useNavigation();
  const { environmentId } = props;
  const adding = useKinBillsAdd<DraftComposerAttachment>(props, (draft, name) =>
    uploadBill(environmentId, draft, name),
  );
  const [picking, setPicking] = useState<string | null>(null);
  const { state } = adding;
  const busy = state.phase !== "choosing";
  const button = kinBillsButton(state);
  const outcome = kinBillsOutcome(state);
  const held = state.files.filter(
    (file) => file.upload._tag !== "added" && file.upload._tag !== "refused",
  ).length;
  const review = (batch: string) =>
    navigation.dispatch(
      StackActions.replace("KinBills", {
        environmentId: String(environmentId),
        orgId: String(props.orgId),
        batch,
      }),
    );
  const openExpense = (task: string) =>
    navigation.dispatch(
      StackActions.replace("KinWorkItem", {
        environmentId: String(environmentId),
        orgId: String(props.orgId),
        task,
      }),
    );
  const take = async (from: "library" | "files" | "camera") => {
    setPicking(null);
    if (from === "camera") {
      const taken = await takeBillPhoto(state.files.length + 1);
      if (taken.photo !== null) adding.choose(kinBillChoices([taken.photo]));
      return setPicking(taken.error);
    }
    const picked =
      from === "library"
        ? await pickComposerMedia({ existingCount: held }).then((result) => ({
            files: result.attachments,
            error: result.error,
          }))
        : await pickComposerFiles({ existingCount: held });
    if (picked.files.length > 0) adding.choose(kinBillChoices(picked.files));
    setPicking(picked.error);
  };
  const send = async () => {
    const done = await adding.send();
    if (done?.close === true && done.review !== null) review(done.review);
  };
  const problem = state.problem ?? picking;
  return (
    <KinWorkFrame
      title={KIN_BILLS.title}
      showTop={problem}
      onClose={() => {
        if (!busy) navigation.goBack();
      }}
      confirm={{
        label: button.label,
        onPress: () => void send(),
        loading: busy,
        disabled: button.disabled,
      }}
    >
      <Text textRole="footnote" className="px-2 text-foreground-muted">
        {KIN_BILLS.hint}
      </Text>
      {problem === null ? null : <Notice message={problem} tone="danger" />}
      <ListSection>
        <ListRow
          icon="photo"
          label={KIN_BILLS.photoLibrary}
          disabled={busy}
          onPress={() => void take("library")}
        />
        <ListRow
          icon="folder"
          label={KIN_BILLS.files}
          disabled={busy}
          onPress={() => void take("files")}
        />
        <ListRow
          icon="camera"
          label={KIN_BILLS.takePhoto}
          disabled={busy}
          onPress={() => void take("camera")}
        />
      </ListSection>
      {state.files.length === 0 ? null : (
        <ListSection title={KIN_BILLS.chosen}>
          {state.files.map((file) => {
            const wrong = file.upload._tag === "failed" || file.upload._tag === "refused";
            const removable =
              !busy && file.upload._tag !== "added" && file.upload._tag !== "uploading";
            return (
              <View
                key={file.id}
                className="min-h-12 flex-row items-center gap-3 bg-grouped-card px-4 py-2"
              >
                <View className="flex-1 gap-0.5">
                  <Text textRole="body" numberOfLines={1} className="text-foreground">
                    {file.name}
                  </Text>
                  <Text
                    textRole="footnote"
                    className={wrong ? "text-danger-foreground" : "text-foreground-muted"}
                  >
                    {kinBillUploadText(file.upload)}
                  </Text>
                </View>
                {removable ? (
                  <IconButton
                    icon="xmark"
                    accessibilityLabel={`${KIN_BILLS.remove} ${file.name}`}
                    onPress={() => adding.remove(file.id)}
                  />
                ) : null}
              </View>
            );
          })}
        </ListSection>
      )}
      {outcome === null || (outcome.lines.length === 0 && outcome.dropped.length === 0) ? null : (
        <View className="gap-1 px-2" accessibilityLiveRegion="polite">
          {outcome.lines.map((line) => (
            <Text key={line} textRole="footnote" className="text-foreground-muted">
              {line}
            </Text>
          ))}
          {outcome.dropped.map((one) => (
            <View key={one.key} className="gap-1">
              <Text textRole="footnote" className="text-foreground-muted">
                {one.text}
              </Text>
              <Button
                size="compact"
                tone="text"
                label={KIN_BILLS.open(one.expense)}
                disabled={busy}
                onPress={() => openExpense(one.expense)}
              />
            </View>
          ))}
        </View>
      )}
      {outcome?.review == null ? null : (
        <Button
          tone="secondary"
          label={KIN_BILLS.review}
          onPress={() => review(outcome.review ?? "")}
        />
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
  const views = rows.map((row) =>
    kinBillRowView(row, {
      categoryLabel: (category) => kinCategoryLabel(category, expenses),
      ...(skipped === undefined ? {} : { skipped }),
    }),
  );
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
            view.file.name,
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
  const counts = batch?.states ?? kinBillCounts(rows);
  const canKeepAll = actions.allowed && kinBillsCanKeepAll(counts);
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
  done: "text-success-foreground",
};

const CHANGES: ReadonlySet<KinBillAction> = new Set([
  "keep",
  "drop",
  "addAnyway",
  "dismiss",
  "byHand",
  "readAgain",
  "edit",
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
  const { file, pdf } = props.view;
  const resource = {
    _tag: "attachment" as const,
    attachmentId: file.attachmentId,
    fileName: file.name,
    mimeType: pdf ? "application/pdf" : file.mimeType,
  };
  // A PDF opens from the host when tapped; only a photo draws from it here.
  const uri = useAssetUrl(props.environmentId, pdf ? null : resource);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${file.name}`}
      onPress={() =>
        props.onPreview({
          kind: pdf ? "pdf" : "image",
          name: file.name,
          mimeType: resource.mimeType,
          environmentId: props.environmentId,
          resource,
        })
      }
      className="size-16 items-center justify-center overflow-hidden rounded-xl border border-border bg-subtle-strong active:opacity-70"
    >
      {pdf ? (
        <SymbolView name="doc.text" size={22} tintColorClassName="accent-icon-muted" />
      ) : uri === null ? null : (
        <ExpoImage
          source={assetImageSource(props.environmentId, resource, uri)}
          style={{ width: 64, height: 64 }}
          contentFit="cover"
          recyclingKey={file.attachmentId}
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
            <View key={field.key} className="min-h-4 flex-row gap-3">
              <Text textRole="footnote" className="w-28 text-foreground-muted">
                {field.label}
              </Text>
              <Text textRole="footnote" numberOfLines={1} className="flex-1 text-foreground">
                {field.value ?? ""}
              </Text>
            </View>
          ))}
        </View>
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
              tone={action === "keep" || action === "addAnyway" ? "secondary" : "text"}
              label={label(view, action)}
              accessibilityLabel={`${label(view, action)}: ${view.file.name}`}
              disabled={props.busy && CHANGES.has(action)}
              onPress={() => props.onAction(view, action)}
            />
          ))}
        </View>
      </View>
    </View>
  );
});
