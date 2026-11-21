import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  KIN_INVOICES,
  KIN_RECEIPTS,
  kinReceiptModeLabel,
  kinReceiptModes,
  kinReceiptReferencePlaceholder,
  kinAdvanceDraft,
  kinAdvanceInput,
  kinBase64Bytes,
  kinDocFileLine,
  kinInvoiceActions,
  kinInvoiceMissingClient,
  kinReceiptView,
  kinTemplatesFor,
  type KinAdvanceDraft,
  type KinInvoiceView,
} from "@t3tools/client-runtime/kin/kinInvoices";
import { KIN_LISTS, kinMoneyText } from "@t3tools/client-runtime/kin/kinLists";
import {
  KIN_LINES,
  kinLineDrafts,
  kinLinesInput,
  type KinLineDraft,
} from "@t3tools/client-runtime/kin/kinMoneyAnswers";
import { kinDefaultTemplate, KIN_TEMPLATES } from "@t3tools/client-runtime/kin/kinTemplates";
import { kinWorkDayOf, kinWorkDueLabel } from "@t3tools/client-runtime/kin/kinWork";
import {
  EnvironmentId,
  KinListId,
  KinOrgId,
  KinRecordKey,
  type KinDocFile,
  type KinListDefinition,
  type KinRecord,
  KIN_DEFAULT_HOME_CURRENCY,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { FilePreviewModal, type FilePreviewSource } from "../../components/ui/FilePreviewModal";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { KinLoadFailed, KinLoadFailedRow } from "./components/KinLoadFailed";
import { ListRow } from "../../components/ui/ListRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { Menu } from "../../components/ui/Menu";
import { Notice } from "../../components/ui/Notice";
import {
  downloadAndShareAttachment,
  nativeViewerErrorMessage,
  writeGeneratedAttachmentFile,
  type AttachmentPreviewFile,
} from "../../lib/attachmentDownload";
import { useNowMinuteMs } from "../../lib/clock";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { useAssetUrlState } from "../../state/assets";
import {
  KinFoldSection,
  KinWorkFrame,
  KinWorkLoading,
  KinWorkTextField,
} from "./components/KinWorkPieces";
import { KinLinesFields } from "./KinMoneyAnswers";
import type { KinMakeStep } from "./kinMakeStep";
import { kinClient } from "./state/kinClient";
import {
  useKinCompanyCountry,
  useKinHomeCurrency,
  useKinMoneyActions,
  useKinReceipts,
  useKinRecipes,
} from "./state/useKinMoney";
import { useKinEntryLines } from "./state/useKinMoneyAnswers";
import { kinWorkChoicesAtom, type KinWorkTarget } from "./state/useKinWork";
import { useKinWorkLink } from "./state/kinWorkLink";
import { useKinGate } from "./state/useKinHost";
import { KinGateView } from "./components/KinWorkPieces";

type MoneyActions = ReturnType<typeof useKinMoneyActions>;

const INVOICES = KinListId.make("invoices");

/** What a money action said: the number it got, what couldn't be made, or why not. */
export function KinMoneyActionNotice(
  props: Partial<KinWorkTarget> & { readonly actions: MoneyActions },
) {
  const { problem, notice, filed, dismiss } = props.actions;
  const openRecord = useKinWorkLink();
  const { environmentId, orgId } = props;
  if (problem === null && notice === null) return null;
  return (
    <Notice
      message={problem ?? notice ?? ""}
      tone={problem === null ? "default" : "danger"}
      onDismiss={dismiss}
      {...(problem !== null || filed === null || environmentId === undefined || orgId === undefined
        ? {}
        : {
            action: {
              label: KIN_INVOICES.openFiled(filed),
              onPress: () => openRecord("KinDoc", { environmentId, orgId, doc: filed }),
            },
          })}
    />
  );
}

/** Make invoice, Issue, Void and its way back. */
export function KinInvoiceActions(
  props: KinWorkTarget & {
    readonly itemKey: KinRecordKey;
    readonly invoice: KinInvoiceView;
    readonly def: KinListDefinition | null;
    readonly actions: MoneyActions;
    readonly busy: boolean;
    /** The invoice's client, to edit when Make invoice needs a detail of theirs. */
    readonly party: { readonly key: string; readonly title: string } | null;
    readonly currency?: string;
    /** Opens Make invoice as the entry sheet's next step. */
    readonly onMake: (step: KinMakeStep) => void;
  },
) {
  const { environmentId, invoice, actions, itemKey } = props;
  const can = kinInvoiceActions(invoice, props.def, {
    render: useAtomValue(kinClient.docRender.permissionAtom(environmentId)),
    issue: useAtomValue(kinClient.workIssue.permissionAtom(environmentId)),
    receipt: useAtomValue(kinClient.makeReceipt.permissionAtom(environmentId)),
  });
  const [reading, setReading] = useState(false);
  const busy = props.busy || actions.busy || reading;
  const askIssue = async () => {
    setReading(true);
    const next = await actions.nextNumber(itemKey);
    setReading(false);
    Dialog.confirm({
      title: KIN_INVOICES.issueTitle,
      message: [
        invoice.issueTotal,
        next === null ? KIN_INVOICES.issueDetail(invoice.prefix) : KIN_INVOICES.issueNumber(next),
      ]
        .filter((line) => line !== null)
        .join("\n"),
      confirmText: KIN_INVOICES.issue,
      onConfirm: () => void actions.issue(itemKey),
    });
  };
  if (!can.make && !can.issue && !can.void && !can.unvoid) return null;
  return (
    <View className="gap-2">
      {can.make ? (
        <Button
          tone="secondary"
          fullWidth
          icon="doc.text"
          label={KIN_INVOICES.makePdf}
          disabled={busy}
          onPress={() =>
            props.onMake({
              list: INVOICES,
              currency: props.currency ?? KIN_DEFAULT_HOME_CURRENCY,
              party: props.party,
            })
          }
        />
      ) : null}
      {can.issue ? (
        <Button
          tone="secondary"
          fullWidth
          icon="checkmark.circle"
          label={KIN_INVOICES.issue}
          loading={actions.busy || reading}
          disabled={busy}
          onPress={() => void askIssue()}
        />
      ) : null}
      {can.unvoid ? (
        <Button
          tone="secondary"
          fullWidth
          icon="arrow.uturn.backward"
          label={KIN_INVOICES.unvoid}
          disabled={busy}
          onPress={() => void actions.unvoid(itemKey)}
        />
      ) : null}
      {can.void ? (
        <Button
          tone="text"
          fullWidth
          label={KIN_INVOICES.voidAction}
          disabled={busy}
          onPress={() =>
            Dialog.confirm({
              title: KIN_INVOICES.voidTitle,
              message: KIN_INVOICES.voidDetail,
              confirmText: KIN_INVOICES.voidAction,
              destructive: true,
              onConfirm: () => void actions.void(itemKey),
            })
          }
        />
      ) : null}
    </View>
  );
}

/** Balance due and what came in; a void invoice says so instead of owing. */
/** Where the invoice was sent from Kin, newest first. */
export function KinInvoiceSent(props: { readonly invoice: KinInvoiceView }) {
  if (props.invoice.sent.length === 0) return null;
  return (
    <View className="gap-0.5">
      {props.invoice.sent.map((line) => (
        <Text key={line} textRole="footnote" className="text-foreground-muted">
          {line}
        </Text>
      ))}
    </View>
  );
}

export function KinInvoiceFigures(props: { readonly invoice: KinInvoiceView }) {
  const { invoice } = props;
  if (invoice.void)
    return (
      <Text textRole="footnote" className="text-foreground-muted">
        {KIN_INVOICES.voidNote}
      </Text>
    );
  if (invoice.balance === null) return null;
  return (
    <View className="flex-row flex-wrap gap-x-6 gap-y-2">
      <View className="gap-0.5">
        <Text textRole="footnote" className="text-foreground-muted">
          {KIN_INVOICES.balance}
        </Text>
        <Text textRole="body" selectable className="tabular-nums text-foreground">
          {invoice.settled ? KIN_INVOICES.paidInFull : invoice.balance}
        </Text>
      </View>
      <View className="gap-0.5">
        <Text textRole="footnote" className="text-foreground-muted">
          {KIN_INVOICES.received}
        </Text>
        <Text textRole="body" selectable className="tabular-nums text-foreground">
          {invoice.received}
        </Text>
      </View>
      {invoice.tdsDeducted === null ? null : (
        <View className="gap-0.5">
          <Text textRole="footnote" className="text-foreground-muted">
            {KIN_INVOICES.tdsDeducted}
          </Text>
          <Text textRole="body" selectable className="tabular-nums text-foreground">
            {invoice.tdsDeducted}
          </Text>
        </View>
      )}
      {invoice.bank === null ? null : (
        <Text textRole="footnote" className="w-full text-foreground-muted">
          {invoice.bank}
        </Text>
      )}
    </View>
  );
}

/** Each payment with its receipt, and taking a payment back. */
export function KinInvoicePayments(
  props: KinWorkTarget & {
    readonly itemKey: KinRecordKey;
    readonly invoice: KinInvoiceView;
    readonly actions: MoneyActions;
    readonly canPay: boolean;
    readonly busy: boolean;
    readonly onTakeBack: (paymentId: string) => void;
  },
) {
  const openRecord = useKinWorkLink();
  const { environmentId, orgId, invoice, actions } = props;
  const canReceipt = useAtomValue(kinClient.makeReceipt.permissionAtom(environmentId));
  const busy = props.busy || actions.busy;
  return (
    <ListSection title={KIN_INVOICES.payments}>
      {invoice.payments.length === 0 ? (
        <Text textRole="body" className="px-4 py-3 text-foreground-muted">
          {KIN_INVOICES.noPayments}
        </Text>
      ) : (
        invoice.payments.map((payment) => {
          const { receipt } = payment;
          const number = receipt === null || receipt._tag === "none" ? null : receipt.number;
          const detail = [
            payment.tds ? KIN_INVOICES.tdsDeducted : null,
            payment.when,
            payment.note,
            payment.source,
            number === null ? null : `Receipt ${number}`,
            payment.voided ? KIN_INVOICES.takenBack : null,
          ]
            .filter((part) => part !== null)
            .join(" · ");
          return (
            <View key={payment.paymentId}>
              <ListRowLayout
                label={payment.amount}
                description={detail}
                disabled={payment.voided}
              />
              {receipt?._tag === "ready" ? (
                <ListActionRow
                  label={`${KIN_INVOICES.openPdf} ${number ?? ""}`.trim()}
                  onPress={() =>
                    openRecord("KinDoc", { environmentId, orgId, doc: receipt.document })
                  }
                />
              ) : receipt === null || !canReceipt ? null : (
                <ListActionRow
                  label={`${receipt._tag === "noPdf" ? KIN_INVOICES.makePdf : KIN_INVOICES.makeReceipt} for ${payment.amount}`}
                  disabled={busy}
                  onPress={() =>
                    void actions.makeReceipt(
                      props.itemKey,
                      receipt._tag === "noPdf"
                        ? { key: receipt.key }
                        : { paymentId: payment.paymentId },
                      `receipt:${payment.paymentId}`,
                    )
                  }
                />
              )}
              {payment.voided || !props.canPay ? null : (
                <ListActionRow
                  label={`${KIN_LISTS.entry.takeBack} ${payment.amount}`}
                  tone="danger"
                  disabled={busy}
                  onPress={() => props.onTakeBack(payment.paymentId)}
                />
              )}
            </View>
          );
        })
      )}
    </ListSection>
  );
}

/** The PDFs made for it, newest first, each opened on its doc's page. */
export function KinInvoiceDocuments(props: KinWorkTarget & { readonly invoice: KinInvoiceView }) {
  const openRecord = useKinWorkLink();
  const { environmentId, orgId } = props;
  return (
    <ListSection title={KIN_INVOICES.documents}>
      {props.invoice.documents.length === 0 ? (
        <Text textRole="body" className="px-4 py-3 text-foreground-muted">
          {KIN_INVOICES.noDocuments}
        </Text>
      ) : (
        props.invoice.documents.map((doc) => (
          <ListRow
            key={doc.key}
            icon="doc.text"
            label={doc.title}
            detail={doc.key}
            onPress={() => openRecord("KinDoc", { environmentId, orgId, doc: doc.key })}
          />
        ))
      )}
    </ListSection>
  );
}

/** A doc's made file, such as an invoice's PDF: open it in the system viewer, or share it. */
// Outside the components: the React Compiler can't lower try statements.
async function shareFile(
  url: string,
  attachment: { readonly name: string; readonly mimeType: string },
): Promise<string | null> {
  try {
    await downloadAndShareAttachment({ url, attachment, signal: new AbortController().signal });
    return null;
  } catch (cause) {
    return nativeViewerErrorMessage(cause);
  }
}

export async function kinWritePreview(file: {
  readonly name: string;
  readonly mimeType: string;
  readonly base64: string;
}): Promise<AttachmentPreviewFile | string> {
  try {
    return await writeGeneratedAttachmentFile({
      bytes: kinBase64Bytes(file.base64),
      attachment: { name: file.name, mimeType: file.mimeType },
    });
  } catch (cause) {
    return nativeViewerErrorMessage(cause);
  }
}

export function KinDocFileRows(props: {
  readonly environmentId: EnvironmentId;
  readonly file: KinDocFile;
}) {
  const { file } = props;
  const resource = {
    _tag: "attachment" as const,
    attachmentId: file.attachmentId,
    fileName: file.name,
    mimeType: file.mimeType,
  };
  const asset = useAssetUrlState(props.environmentId, resource);
  const url = asset._tag === "Success" ? asset.url : null;
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [preview, setPreview] = useState<FilePreviewSource | null>(null);
  const share = async () => {
    if (url === null) return;
    setBusy(true);
    setProblem(null);
    setProblem(await shareFile(url, { name: file.name, mimeType: file.mimeType }));
    setBusy(false);
  };
  return (
    <View className="gap-2">
      <ListSection>
        <ListRowLayout icon="doc.text" label={file.name} description={kinDocFileLine(file)} />
        <ListActionRow
          label="Open"
          onPress={() =>
            setPreview({
              kind: file.mimeType === "application/pdf" ? "pdf" : "document",
              environmentId: props.environmentId,
              resource,
              name: file.name,
              mimeType: file.mimeType,
            })
          }
        />
        <ListActionRow
          label="Share or save"
          loading={busy}
          disabled={url === null || busy}
          onPress={() => void share()}
        />
      </ListSection>
      {problem === null ? null : <Notice message={problem} tone="danger" />}
      <FilePreviewModal source={preview} onRequestClose={() => setPreview(null)} />
    </View>
  );
}

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeOrgId = Schema.decodeUnknownOption(KinOrgId);
const decodeKey = Schema.decodeUnknownOption(KinRecordKey);

const targetOf = (params: { readonly environmentId: string; readonly orgId: string }) => {
  const environmentId = Option.getOrNull(decodeEnvironmentId(params.environmentId));
  const orgId = Option.getOrNull(decodeOrgId(params.orgId));
  return environmentId === null || orgId === null ? null : { environmentId, orgId };
};

/**
 * Pick a template, see the PDF as it would be made, then file it: the entry's sheet turns into
 * this form, with Back to the entry, never a second sheet over it.
 */
export function KinMakeDocumentStep(
  props: KinWorkTarget &
    KinMakeStep & { readonly itemKey: KinRecordKey; readonly onBack: () => void },
) {
  const navigation = useNavigation();
  const actions = useKinMoneyActions(props);
  const readLines = useKinEntryLines(props);
  const [lines, setLines] = useState<ReadonlyArray<KinLineDraft> | null>(null);
  const [linesProblem, setLinesProblem] = useState<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the lines its last document was made with from the host once, when the sheet opens
  useEffect(() => {
    let live = true;
    void readLines(props.itemKey).then((held) => {
      if (live) setLines(kinLineDrafts(held));
    });
    return () => {
      live = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- once per entry; the reader is remade every render
  }, [props.itemKey]);
  const inputsOf = () => {
    const checked = kinLinesInput(lines ?? [], props.currency);
    if (!checked.ok) {
      setLinesProblem(checked.problem);
      return null;
    }
    setLinesProblem(null);
    return checked.lines === null ? {} : { lines: checked.lines };
  };
  const gate = useKinGate(
    kinClient.docRender.permissionStateAtom(props.environmentId),
    props.environmentId,
  );
  const allowed = gate === null;
  const recipes = useKinRecipes(props, allowed);
  const [picked, setPicked] = useState<string | null>(null);
  const [previewed, setPreviewed] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [shown, setShown] = useState<{
    readonly file: AttachmentPreviewFile;
    readonly name: string;
    readonly mimeType: string;
  } | null>(null);
  const [requestId] = useState(uuidv4);
  const close = props.onBack;
  const title = KIN_INVOICES.makePdf;
  if (!allowed)
    return (
      <KinWorkFrame title={title} onBack={close} guardBack>
        <KinGateView gate={gate ?? "refused"} refused={KIN_LISTS.onlyOwner} label={title} />
      </KinWorkFrame>
    );
  const { state } = recipes;
  const templates = state._tag === "ready" ? kinTemplatesFor(state.value.recipes, props.list) : [];
  const recipe = templates.find((one) => one.name === picked) ?? kinDefaultTemplate(templates);
  const missing = kinInvoiceMissingClient(actions.problem, props.party);
  const preview = async () => {
    if (recipe === null) return;
    const inputs = inputsOf();
    if (inputs === null) return;
    setFailed(null);
    const files = await actions.preview(recipe.name, props.itemKey, inputs);
    const file = files?.[0];
    if (file === undefined) {
      if (files !== null) setFailed(KIN_INVOICES.previewFailed);
      return;
    }
    const written = await kinWritePreview(file);
    if (typeof written === "string") return setFailed(written);
    shown?.file.dispose();
    setShown({ file: written, name: file.name, mimeType: file.mimeType });
    setPreviewed(recipe.name);
  };
  const ready = recipe !== null && previewed === recipe.name;
  return (
    <KinWorkFrame
      title={title}
      onBack={close}
      guardBack
      confirm={
        recipe === null
          ? undefined
          : {
              label: KIN_INVOICES.file,
              loading: actions.busy && ready,
              disabled: actions.busy || !ready,
              onPress: async () => {
                const inputs = inputsOf();
                if (inputs === null) return;
                if ((await actions.file(recipe.name, props.itemKey, requestId, inputs)) !== null)
                  close();
              },
            }
      }
    >
      {state._tag === "loading" ? (
        <KinWorkLoading label="Loading templates" />
      ) : state._tag !== "ready" ? (
        <KinLoadFailed
          title={KIN_TEMPLATES.loadFailed}
          cause={state._tag === "failed" ? state.cause : null}
          onRetry={recipes.refresh}
        />
      ) : recipe === null ? (
        <EmptyState
          variant="plain"
          title="No invoice template yet"
          detail="Ask an agent to set one up."
        />
      ) : (
        <>
          {templates.length > 1 ? (
            <ListSection title={KIN_INVOICES.template}>
              <Menu
                title={KIN_INVOICES.template}
                accessibilityRole="button"
                accessibilityLabel={`${KIN_INVOICES.template}: ${recipe.title}. Change`}
                actions={templates.map((one) => ({
                  id: one.name,
                  title: one.title,
                  state: one.name === recipe.name ? ("on" as const) : ("off" as const),
                }))}
                onPressAction={({ nativeEvent: { event } }) => {
                  setPicked(templates.find((one) => one.name === event)?.name ?? null);
                  setPreviewed(null);
                }}
              >
                <View pointerEvents="none">
                  <ListRowLayout label={recipe.title} detail={KIN_INVOICES.template} />
                </View>
              </Menu>
            </ListSection>
          ) : null}
          {recipe.description.trim() === "" ? null : (
            <Text textRole="footnote" className="px-2 text-foreground-muted">
              {recipe.description}
            </Text>
          )}
          {lines === null ? (
            <KinWorkLoading label={KIN_LINES.title} />
          ) : (
            <KinLinesFields
              lines={lines}
              disabled={actions.busy}
              onChange={(next) => {
                setLines(next);
                setLinesProblem(null);
                setPreviewed(null);
              }}
            />
          )}
          {linesProblem === null ? null : <Notice message={linesProblem} tone="danger" />}
          <Button
            tone={ready ? "secondary" : "primary"}
            fullWidth
            label={actions.busy && !ready ? KIN_INVOICES.previewing : KIN_INVOICES.preview}
            loading={actions.busy && !ready}
            disabled={actions.busy}
            onPress={() => void preview()}
          />
          {ready ? (
            <Text textRole="footnote" className="px-2 text-foreground-muted">
              Looks right? Tap {KIN_INVOICES.file} to keep it under Documents.
            </Text>
          ) : null}
          {failed === null ? null : <Notice message={failed} tone="danger" />}
          <KinMoneyActionNotice actions={actions} />
          {missing === null ? null : (
            <View className="gap-2 px-2">
              <Text textRole="body" className="text-foreground">
                {KIN_INVOICES.missingClient(missing.name)}
              </Text>
              <Button
                tone="secondary"
                fullWidth
                label={KIN_INVOICES.editClient(missing.name)}
                onPress={() => {
                  actions.dismiss();
                  navigation.navigate("KinClientForm", {
                    environmentId: props.environmentId,
                    orgId: props.orgId,
                    party: missing.key,
                  });
                }}
              />
            </View>
          )}
        </>
      )}
      <FilePreviewModal
        source={
          shown === null
            ? null
            : { kind: "pdf", uri: shown.file.uri, name: shown.name, mimeType: shown.mimeType }
        }
        onRequestClose={() => {
          shown?.file.dispose();
          setShown(null);
        }}
      />
    </KinWorkFrame>
  );
}

/** Money's receipts, inside Money. */
export function KinReceiptsSection(props: KinWorkTarget & { readonly seq: number | null }) {
  const navigation = useNavigation();
  const openRecord = useKinWorkLink();
  const { environmentId, orgId } = props;
  const canRead = useAtomValue(kinClient.receiptsRead.permissionAtom(environmentId));
  const canMake = useAtomValue(kinClient.makeReceipt.permissionAtom(environmentId));
  const { state, refresh } = useKinReceipts(props, { enabled: canRead });
  const now = new Date(useNowMinuteMs());
  const [all, setAll] = useState(false);
  if (!canRead || state._tag === "refused") return null;
  const receipts =
    state._tag === "ready" ? state.value.receipts.map((one) => kinReceiptView(one, now)) : [];
  const shown = all ? receipts : receipts.slice(0, 8);
  // Absent with none: Money's Add makes the first one.
  if (state._tag === "ready" && receipts.length === 0) return null;
  const settable = receipts.filter((one) => one.settable !== null).length;
  return (
    <KinFoldSection
      title={KIN_RECEIPTS.title}
      summary={
        state._tag !== "ready"
          ? null
          : [
              receipts.length === 1 ? "1 receipt" : `${receipts.length} receipts`,
              settable === 0 ? null : `${settable} to set against an invoice`,
            ]
              .filter((part) => part !== null)
              .join(", ")
      }
    >
      {state._tag === "loading" ? (
        <KinWorkLoading label="Loading receipts" />
      ) : state._tag !== "ready" ? (
        <KinLoadFailedRow
          title="Couldn't load receipts"
          cause={state._tag === "failed" ? state.cause : null}
          onRetry={refresh}
        />
      ) : receipts.length === 0 ? (
        <Text textRole="body" className="px-4 py-3 text-foreground-muted">
          {KIN_RECEIPTS.empty}
        </Text>
      ) : (
        shown.map((receipt) => (
          <View key={receipt.key}>
            <ListRowLayout
              label={[
                receipt.heading,
                receipt.advance ? KIN_RECEIPTS.advance : null,
                receipt.void ? KIN_RECEIPTS.void : null,
              ]
                .filter((part) => part !== null)
                .join(" · ")}
              description={[receipt.when, receipt.from, receipt.towards, receipt.applied]
                .filter((part) => part !== null)
                .join(" · ")}
              detail={receipt.amount ?? undefined}
              disabled={receipt.void}
            />
            {receipt.document === null ? null : (
              <ListActionRow
                label={`${KIN_INVOICES.openPdf} ${receipt.heading}`}
                onPress={() =>
                  receipt.document !== null &&
                  openRecord("KinDoc", { environmentId, orgId, doc: receipt.document })
                }
              />
            )}
            {receipt.settable === null || !canMake ? null : (
              <ListActionRow
                label={KIN_RECEIPTS.setAgainst}
                onPress={() =>
                  navigation.navigate("KinReceiptApply", {
                    environmentId,
                    orgId,
                    receipt: receipt.key,
                    ...(receipt.settable?.party == null ? {} : { party: receipt.settable.party }),
                  })
                }
              />
            )}
          </View>
        ))
      )}
      {receipts.length > 8 && !all ? (
        <ListActionRow label={`Show all ${receipts.length}`} onPress={() => setAll(true)} />
      ) : null}
      {canMake ? (
        <ListActionRow
          label={KIN_RECEIPTS.newReceipt}
          description={KIN_RECEIPTS.newDetail}
          onPress={() => navigation.navigate("KinReceiptNew", { environmentId, orgId })}
        />
      ) : null}
    </KinFoldSection>
  );
}

export type KinReceiptNewParams = { readonly environmentId: string; readonly orgId: string };

/** Money received before any invoice: its receipt, numbered, with its PDF. */
export function KinReceiptNewScreen({ route }: StaticScreenProps<KinReceiptNewParams>) {
  const navigation = useNavigation();
  const target = targetOf(route.params);
  if (target === null)
    return (
      <KinWorkFrame title={KIN_RECEIPTS.newReceipt} onClose={() => navigation.goBack()}>
        <EmptyState variant="plain" {...KIN_LISTS.entry.gone} />
      </KinWorkFrame>
    );
  return <ReceiptForm {...target} />;
}

function ReceiptForm(props: KinWorkTarget) {
  const navigation = useNavigation();
  const actions = useKinMoneyActions(props);
  // A plain number is in the home currency; a typed symbol or code still names its own.
  const home = useKinHomeCurrency(props) ?? KIN_DEFAULT_HOME_CURRENCY;
  const country = useKinCompanyCountry(props);
  const now = new Date(useNowMinuteMs());
  const today = kinWorkDayOf(now);
  const [draft, setDraft] = useState<KinAdvanceDraft>(() => kinAdvanceDraft(today));
  const [problem, setProblem] = useState<string | null>(null);
  const [requestId] = useState(uuidv4);
  const clients =
    Option.getOrNull(AsyncResult.value(useAtomValue(kinWorkChoicesAtom(props))))?.clients ?? [];
  const payer = clients.find((one) => one.key === draft.party) ?? null;
  const days = [0, 1, 2, 3, 4, 5, 6].map((back) => {
    const day = new Date(now);
    day.setDate(day.getDate() - back);
    return kinWorkDayOf(day);
  });
  const close = () => navigation.goBack();
  const save = async () => {
    const checked = kinAdvanceInput(props.orgId, draft, home, requestId);
    if (!checked.ok) return setProblem(checked.problem);
    setProblem(null);
    const { orgId: _orgId, clientRequestId, ...input } = checked.input;
    if ((await actions.makeReceipt(undefined, input, clientRequestId)) !== null) close();
  };
  return (
    <KinWorkFrame
      title={KIN_RECEIPTS.newReceipt}
      form
      onClose={close}
      confirm={{
        label: KIN_RECEIPTS.save,
        onPress: () => void save(),
        loading: actions.busy,
        disabled: actions.busy || draft.amount.trim() === "",
      }}
    >
      <Text textRole="footnote" className="px-2 text-foreground-muted">
        {KIN_RECEIPTS.newDetail}
      </Text>
      {problem === null && actions.problem === null ? null : (
        <Notice message={problem ?? actions.problem ?? ""} tone="danger" />
      )}
      <ListSection>
        <Menu
          title={KIN_RECEIPTS.party}
          accessibilityRole="button"
          accessibilityLabel={`${KIN_RECEIPTS.party}: ${payer?.name ?? KIN_RECEIPTS.noClient}. Change`}
          actions={[
            { id: "", title: KIN_RECEIPTS.noClient, state: payer === null ? "on" : "off" },
            ...clients.map((one) => ({
              id: one.key,
              title: one.name,
              state: one.key === draft.party ? ("on" as const) : ("off" as const),
            })),
          ]}
          onPressAction={({ nativeEvent: { event } }) =>
            setDraft({ ...draft, party: clients.find((one) => one.key === event)?.key ?? null })
          }
        >
          <View pointerEvents="none">
            <ListRowLayout
              label={payer?.name ?? KIN_RECEIPTS.noClient}
              detail={KIN_RECEIPTS.party}
            />
          </View>
        </Menu>
        <Menu
          title={KIN_RECEIPTS.day}
          accessibilityRole="button"
          accessibilityLabel={`${KIN_RECEIPTS.day}: ${kinWorkDueLabel(draft.receivedOn, now)}. Change`}
          actions={days.map((day) => ({
            id: day,
            title: kinWorkDueLabel(day, now),
            state: day === draft.receivedOn ? ("on" as const) : ("off" as const),
          }))}
          onPressAction={({ nativeEvent: { event } }) => setDraft({ ...draft, receivedOn: event })}
        >
          <View pointerEvents="none">
            <ListRowLayout
              icon="clock"
              label={kinWorkDueLabel(draft.receivedOn, now)}
              detail={KIN_RECEIPTS.day}
            />
          </View>
        </Menu>
      </ListSection>
      <KinWorkTextField
        label={KIN_RECEIPTS.amount}
        value={draft.amount}
        onChangeText={(amount) => setDraft({ ...draft, amount })}
        keyboard="numbers"
        autoFocus
      />
      <KinWorkTextField
        label={KIN_RECEIPTS.towards}
        value={draft.towards}
        onChangeText={(towards) => setDraft({ ...draft, towards })}
        maxLength={300}
      />
      <ListSection>
        <Menu
          title={KIN_RECEIPTS.mode}
          accessibilityRole="button"
          accessibilityLabel={`${KIN_RECEIPTS.mode}: ${kinReceiptModeLabel(draft.mode)}. Change`}
          actions={[
            { id: "", title: KIN_RECEIPTS.noMode, state: draft.mode === "" ? "on" : "off" },
            ...kinReceiptModes(country).map((one) => ({
              id: one.value,
              title: one.label,
              state: one.value === draft.mode ? ("on" as const) : ("off" as const),
            })),
          ]}
          onPressAction={({ nativeEvent: { event } }) => setDraft({ ...draft, mode: event })}
        >
          <View pointerEvents="none">
            <ListRowLayout label={kinReceiptModeLabel(draft.mode)} detail={KIN_RECEIPTS.mode} />
          </View>
        </Menu>
      </ListSection>
      <KinWorkTextField
        label={KIN_RECEIPTS.reference}
        value={draft.reference}
        onChangeText={(reference) => setDraft({ ...draft, reference })}
        placeholder={kinReceiptReferencePlaceholder(country)}
        maxLength={120}
      />
    </KinWorkFrame>
  );
}

export type KinReceiptApplyParams = {
  readonly environmentId: string;
  readonly orgId: string;
  readonly receipt: string;
  readonly party?: string;
};

/** Puts an advance against one of the client's open invoices, as a payment on it. */
export function KinReceiptApplyScreen({ route }: StaticScreenProps<KinReceiptApplyParams>) {
  const navigation = useNavigation();
  const target = targetOf(route.params);
  const receipt = Option.getOrNull(decodeKey(route.params.receipt));
  if (target === null || receipt === null)
    return (
      <KinWorkFrame title={KIN_RECEIPTS.setAgainst} onClose={() => navigation.goBack()}>
        <EmptyState variant="plain" {...KIN_LISTS.entry.gone} />
      </KinWorkFrame>
    );
  return (
    <ApplyReceipt
      {...target}
      receipt={receipt}
      party={Option.getOrNull(decodeKey(route.params.party))}
    />
  );
}

function ApplyReceipt(
  props: KinWorkTarget & { readonly receipt: KinRecordKey; readonly party: KinRecordKey | null },
) {
  const navigation = useNavigation();
  const { environmentId, orgId, party: payer } = props;
  const actions = useKinMoneyActions(props);
  const [attempt, setAttempt] = useState(0);
  const [held, setHeld] = useState<{
    readonly attempt: number;
    readonly invoices: ReadonlyArray<KinRecord> | null;
    readonly cause: unknown;
  } | null>(null);
  const [requestId] = useState(uuidv4);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the client's open invoices from the host when the sheet opens or Try again is pressed
  useEffect(() => {
    let current = true;
    void kinClient.workList
      .run(appAtomRegistry, {
        environmentId,
        input: {
          orgId,
          list: INVOICES,
          states: ["waiting"],
          ...(payer === null ? {} : { party: payer }),
          limit: 50,
        },
      })
      .then((result) => {
        if (current)
          setHeld({
            attempt,
            invoices: AsyncResult.isSuccess(result) ? result.value.records : null,
            cause: result,
          });
      });
    return () => {
      current = false;
    };
  }, [environmentId, orgId, payer, attempt]);
  const invoices = held?.attempt === attempt ? held.invoices : undefined;
  const close = () => navigation.goBack();
  return (
    <KinWorkFrame title={KIN_RECEIPTS.setAgainst} onClose={close}>
      <Text textRole="footnote" className="px-2 text-foreground-muted">
        {KIN_RECEIPTS.setAgainstDetail}
      </Text>
      <KinMoneyActionNotice actions={actions} />
      {invoices === undefined ? (
        <KinWorkLoading label="Loading invoices" />
      ) : invoices === null ? (
        <KinLoadFailed
          title={KIN_INVOICES.loadFailed}
          cause={held?.cause}
          onRetry={() => setAttempt((count) => count + 1)}
        />
      ) : invoices.length === 0 ? (
        <EmptyState variant="plain" title="No open invoice" detail={KIN_RECEIPTS.noInvoices} />
      ) : (
        <ListSection title={KIN_RECEIPTS.pickInvoice}>
          {invoices.map((invoice) => (
            <ListRow
              key={invoice.key}
              label={invoice.title}
              detail={invoice.balance === undefined ? undefined : kinMoneyText(invoice.balance)}
              disabled={actions.busy}
              onPress={async () => {
                const made = await actions.makeReceipt(
                  invoice.key,
                  { key: props.receipt, against: invoice.key },
                  requestId,
                );
                if (made !== null) close();
              }}
            />
          ))}
        </ListSection>
      )}
    </KinWorkFrame>
  );
}
