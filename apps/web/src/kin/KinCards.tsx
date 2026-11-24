import { kinSentences } from "@t3tools/client-runtime/kin/kinScreenState";
import { KIN_DEVICE_COPY } from "@t3tools/client-runtime/kin/kinDevice";
import { KIN_RETRY } from "@t3tools/client-runtime/kin/kinAnswers";
import { kinBodyMarkdown } from "@t3tools/client-runtime/kin/kinChatFeed";
import { useAtomValue } from "@effect/atom-react";
import {
  KIN_MISSING_CARD_TEXT,
  kinCardView,
  kinTaskCardWithoutThread,
  type KinDigestCardView,
  type KinTaskCardView,
  type KinTaskTone,
  KIN_CARD_COPY,
} from "@t3tools/client-runtime/kin/kinCardPresentation";
import {
  kinAddressPieces,
  kinChoiceCardActions,
  kinChoiceCardTaps,
  kinChoiceAccessibilityLabel,
  kinChoiceAnswered,
  kinChoiceDecidedLine,
  createKinHeldPress,
  kinDeviceTimers,
  kinMailCancels,
  KIN_MAIL_CANCEL_COPY,
  KIN_MAIL_CANCEL_UNDO_MS,
  kinChoicePhase,
  kinChoiceUndoneLine,
  KIN_CHOICE_DISMISS_COPY,
  kinChoiceDismissedLine,
  kinChoiceDismissible,
  kinSendEditControls,
  kinSendEditedLine,
  kinSendEditBound,
  kinSendEditHeld,
  kinSendEditHeldKey,
  kinSendEditHold,
  kinSendEditLeaveSaves,
  kinSendEditOffered,
  kinSendEditShown,
  kinSendEditStart,
  kinSendEditUnsaved,
  kinSendEditWarned,
  kinSendCheckPending,
  kinSendTicked,
  KIN_SEND_CHECKED,
  KIN_SEND_EDIT_COPY,
  KIN_CHOICE_DRAFT_COPY,
  KIN_CHOICE_OPEN_LABEL,
  type KinChoiceDraftView,
  type KinChoiceOpen,
  type KinSendEditBusy,
  type KinChoiceCardStatus,
  type KinChoiceCardView,
  type KinSendEditDraft,
  type KinSendEditAck,
  type KinSendEditing,
} from "@t3tools/client-runtime/kin/kinChoicePresentation";
import {
  createKinCardActions,
  kinActionFailureNotice,
  kinCardStatusAfter,
  kinDeferralActInput,
  kinDeferralCountdown,
  visibleKinCardStatus,
  type KinCardNotice,
  type KinCardStatus,
  type KinDeferralActionId,
  type KinDeferralCardView,
} from "@t3tools/client-runtime/kin/kinDeferralPresentation";
import {
  KIN_APPROVAL_STATE_TEXT,
  type KinApprovalWidgetView,
} from "@t3tools/client-runtime/kin/kinApprovalPresentation";
import {
  kinMemoryUndoFailureText,
  type KinMemoryChangeItemView,
  type KinMemoryChangesCardView,
} from "@t3tools/client-runtime/kin/kinMemoryChangesPresentation";
import {
  kinDocCardDraft,
  kinDocCardLine,
  kinDocSendUpProblem,
  kinDocWholeCopy,
  KIN_DOCS,
  type KinDocCardDraftView,
  type KinDocCardView,
} from "@t3tools/client-runtime/kin/kinDocs";
import { kinListedModelName } from "@t3tools/client-runtime/kin/kinLeadPresentation";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type KinPersonId,
  KinRecordKey,
  type KinSendTry,
  type KinWidget,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import ChatMarkdown from "../components/ChatMarkdown";
import type { KinPlaceSearch } from "./kinPlaces";
import { AsyncResult } from "effect/reactivity";
import { FileTextIcon } from "lucide-react";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "../components/ui/menu";
import {
  Fragment,
  memo,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { useAssetUrls } from "../assets/assetUrls";
import { AttachmentImage } from "../components/media/AttachmentImage";
import { environmentCatalog } from "../connection/catalog";
import { KinConfirm } from "./KinConfirm";
import { ApproveOnPhone } from "./ApproveOnPhone";
import { useKinOwnerLevelKnown } from "./useKinOwnerLevel";
import { useNowMinuteMs } from "./useKinClock";
import { cn, randomUUID } from "../lib/utils";
import { useAtomCommand } from "../state/use-atom-command";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Textarea } from "../components/ui/textarea";
import { PullRequestGlyph } from "../components/pullRequest/pullRequestIcons";
import { KinChart } from "./KinChart";
import { KinSocialPackCard, KinSocialWeekCard } from "./KinSocialCards";
import { KinHostTroubleCard } from "./KinHostTroubleCard";
import { KinStatementPasswordCard, KinStatementReviewCard } from "./KinStatementCards";
import { KinVisual } from "./KinVisual";
import { kinClient } from "./kinClient";
import { kinHostConnected, useKinHostAt } from "./useKinHost";
import { KIN_WEB_ONLY } from "./kinWebOnly";
import { toastManager } from "../components/ui/toast";
import { serverEnvironment } from "../state/server";

const CANT_ACT_TEXT = KIN_DEVICE_COPY.cantAct("browser", "answer");

export function CardFrame(props: {
  readonly eyebrow?: string;
  readonly label?: string;
  readonly children: ReactNode;
}) {
  return (
    <section
      aria-label={props.label}
      className="flex flex-col gap-2 rounded-xl border border-border bg-card px-4 py-3 text-sm"
    >
      {props.eyebrow === undefined ? null : (
        <p className="text-xs font-medium text-muted-foreground">{props.eyebrow}</p>
      )}
      {props.children}
    </section>
  );
}

const NOTICE_CLASSES: Record<KinCardNotice["kind"], string> = {
  sent: "text-muted-foreground",
  stale: "text-warning-foreground",
  error: "text-destructive-foreground",
};

function CardNotice(props: { readonly notice: KinCardNotice | null | undefined }) {
  const { notice } = props;
  if (notice == null) return null;
  return (
    <p
      role={notice.kind === "sent" ? "status" : "alert"}
      className={cn("text-xs font-medium", NOTICE_CLASSES[notice.kind])}
    >
      {notice.text}
    </p>
  );
}

/** Posts a card tap through the guarded widget command. */
function useWidgetPost(environmentId: EnvironmentId) {
  const post = useAtomCommand(kinClient.widgetAction, { reportFailure: false });
  return async (input: Parameters<typeof post>[0]["input"]) => {
    const result = await post({ environmentId, input });
    return AsyncResult.isFailure(result)
      ? { ok: false as const, cause: squashAtomCommandFailure(result) }
      : { ok: true as const };
  };
}

/** A model id as Settings names it on this environment, or null where it has no name. */
export function useKinModelName(environmentId: EnvironmentId) {
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  return (model: string) => kinListedModelName(model, providers);
}

/**
 * The card for a message's widget, drawn from the shared presentation. Never renders HTML of
 * its own: a visual's page stays in a sealed frame (`KinVisual`).
 */
export const KinCard = memo(function KinCard(props: {
  readonly widget: KinWidget | undefined;
  readonly environmentId: EnvironmentId;
  readonly orgId: string;
  readonly viewerPersonId: KinPersonId | null;
  readonly heldFor: string | null;
  /** The viewer may only read this chat: a draft's card offers no Send to. */
  readonly readOnly?: boolean;
}) {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const ownerLevel = useKinOwnerLevelKnown(props.environmentId);
  const modelName = useKinModelName(props.environmentId);
  const view = kinCardView(
    props.widget,
    props.environmentId,
    (environmentId) => !catalog.isReady || catalog.entries.has(environmentId),
    props.heldFor,
    ownerLevel,
    modelName,
  );
  switch (view.kind) {
    case "task":
      return <KinTaskCard task={KIN_WEB_ONLY ? kinTaskCardWithoutThread(view.task) : view.task} />;
    case "deferral":
      return <KinDeferralCard deferral={view.deferral} environmentId={props.environmentId} />;
    case "choice":
      return (
        <KinChoiceCard
          choice={view.choice}
          environmentId={props.environmentId}
          viewerPersonId={props.viewerPersonId}
        />
      );
    case "chart":
      return (
        <CardFrame>
          <KinChart view={view.chart} />
        </CardFrame>
      );
    case "visual":
      return (
        <CardFrame label={view.visual.title}>
          <KinVisual environmentId={props.environmentId} orgId={view.orgId} visual={view.visual} />
        </CardFrame>
      );
    case "digest":
      return <KinDigestCard digest={view.digest} />;
    case "memory_changes":
      return <KinMemoryChangesCard changes={view.changes} environmentId={props.environmentId} />;
    case "approval":
      return <KinApprovalCard approval={view.approval} />;
    case "doc":
      return (
        <KinDocCard
          doc={view.doc}
          environmentId={props.environmentId}
          orgId={props.orgId}
          ownerLevel={ownerLevel !== false}
          readOnly={props.readOnly === true}
        />
      );
    case "statement_review":
      return <KinStatementReviewCard review={view.review} environmentId={props.environmentId} />;
    case "statement_password":
      return (
        <KinStatementPasswordCard password={view.password} environmentId={props.environmentId} />
      );
    case "social_week":
      return <KinSocialWeekCard week={view.week} environmentId={props.environmentId} />;
    case "social_pack":
      return <KinSocialPackCard pack={view.pack} environmentId={props.environmentId} />;
    case "host_trouble":
      return <KinHostTroubleCard widget={view.widget} environmentId={props.environmentId} />;
    case "missing":
      return (
        <CardFrame>
          <p className="text-muted-foreground">{KIN_MISSING_CARD_TEXT}</p>
        </CardFrame>
      );
    case "unknown":
      return view.text === null ? null : (
        <CardFrame>
          <p>{view.text}</p>
        </CardFrame>
      );
  }
});

export const TONE_CLASSES: Record<KinTaskTone, string> = {
  active: "text-foreground",
  attention: "text-warning-foreground",
  done: "text-success-foreground",
  muted: "text-muted-foreground",
};

function KinTaskCard(props: { readonly task: KinTaskCardView }) {
  const { task } = props;
  return (
    <CardFrame eyebrow="Task" label={task.accessibilityLabel}>
      <p className="font-medium text-foreground">{task.title}</p>
      <p className={cn("text-xs font-medium", TONE_CLASSES[task.tone])}>{task.statusLabel}</p>
      {task.detail === null ? null : (
        <p className="line-clamp-4 text-xs text-muted-foreground">{task.detail}</p>
      )}
      {task.detailNote === null ? null : (
        <p className="line-clamp-4 text-2xs text-muted-foreground">{task.detailNote}</p>
      )}
      {task.unknownEnvironment ? (
        <p className="text-xs text-muted-foreground">
          {KIN_DEVICE_COPY.unknownEnvironment("browser")}
        </p>
      ) : null}
      {task.open === null && task.pullRequests.length === 0 && task.model === null ? null : (
        <div className="flex flex-wrap items-center gap-2">
          {task.open === null ? null : (
            <Button
              size="xs"
              variant="outline"
              render={
                <Link
                  to="/$environmentId/$threadId"
                  params={{
                    environmentId: task.open.environmentId,
                    threadId: task.open.threadId,
                  }}
                />
              }
            >
              Open thread
            </Button>
          )}
          {task.pullRequests.map((pr) => (
            <Button
              key={pr.url}
              size="xs"
              variant="outline"
              render={<a href={pr.url} target="_blank" rel="noreferrer noopener" />}
            >
              <PullRequestGlyph.pullRequest />
              {pr.label}
            </Button>
          ))}
          {task.model === null ? null : (
            <span className="truncate text-xs text-muted-foreground">{task.model}</span>
          )}
        </div>
      )}
    </CardFrame>
  );
}

/** A doc an agent wrote or changed: what it is, what changed, and the way to read either. */
function KinDocCard(props: {
  readonly doc: KinDocCardView;
  readonly environmentId: EnvironmentId;
  readonly orgId: string;
  readonly ownerLevel: boolean;
  readonly readOnly: boolean;
}) {
  const { doc } = props;
  const draft = kinDocCardDraft(doc, props.ownerLevel, props.readOnly);
  const sendUp = useAtomCommand(kinClient.docSendUp, { reportFailure: false });
  const readVersion = useAtomCommand(kinClient.docVersion, { reportFailure: false });
  const [sending, setSending] = useState(false);
  const [copying, setCopying] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const copy = (text: string) => {
    void navigator.clipboard.writeText(text).then(
      () => toastManager.add({ type: "success", title: KIN_DOCS.textCopied }),
      () => undefined,
    );
  };
  // A long draft's card holds its opening: Copy text takes the whole of that version.
  const copyDraft = async (shown: KinDocCardDraftView) => {
    if (shown.long === undefined) return copy(shown.copyText);
    if (copying) return;
    setCopying(true);
    setProblem(null);
    const got = kinDocWholeCopy(
      await readVersion({
        environmentId: props.environmentId,
        input: { orgId: doc.orgId, key: KinRecordKey.make(doc.key), version: shown.long.version },
      }),
    );
    setCopying(false);
    if ("problem" in got) return setProblem(got.problem);
    await navigator.clipboard.writeText(got.text).then(
      () => toastManager.add({ type: "success", title: KIN_DOCS.textCopied }),
      () => setProblem(KIN_DOCS.copyFailed),
    );
  };
  const send = async () => {
    if (sending) return;
    if (!kinHostConnected(props.environmentId)) return setProblem(KIN_DOCS.sendOffline);
    setSending(true);
    setProblem(null);
    const result = await sendUp({
      environmentId: props.environmentId,
      input: { orgId: doc.orgId, chatId: doc.chatId, widgetId: doc.widgetId },
    });
    setSending(false);
    setProblem(kinDocSendUpProblem(result));
  };
  const nowMs = useNowMinuteMs();
  const host = useKinHostAt(props.environmentId);
  const agents =
    host._tag === "host" && host.probe._tag === "ready"
      ? (host.probe.orgs.orgs.find((org) => org.orgId === props.orgId)?.agents ?? [])
      : [];
  const line = kinDocCardLine(
    doc,
    new Map(agents.map((agent) => [agent.agentId, agent.displayName])),
    new Date(nowMs),
  );
  const params = { environmentId: props.environmentId, orgId: props.orgId };
  const eyebrow = draft === null ? "Doc" : KIN_DOCS.draft;
  return (
    <CardFrame eyebrow={eyebrow} label={`${eyebrow}: ${doc.title}. ${line.text}`}>
      <p className="font-medium text-foreground">{doc.title}</p>
      <p className="text-xs text-muted-foreground">{line.text}</p>
      {draft?.noAccount == null ? null : (
        <p className="text-xs text-muted-foreground">{draft.noAccount}</p>
      )}
      {draft?.long === undefined ? null : (
        <p className="text-xs text-muted-foreground">{draft.long.line}</p>
      )}
      {draft?.sent == null ? null : <p className="text-xs text-foreground">{draft.sent}</p>}
      {problem === null ? null : (
        <p role="alert" className="text-xs text-destructive-foreground">
          {problem}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {draft === null ? null : (
          <Button
            size="xs"
            variant="outline"
            disabled={copying}
            onClick={() => void copyDraft(draft)}
          >
            {copying ? KIN_DOCS.copying : KIN_DOCS.copyText}
          </Button>
        )}
        {draft?.sendTo == null ? null : (
          <Button size="xs" variant="outline" disabled={sending} onClick={() => void send()}>
            {sending ? KIN_DOCS.sending : draft.sendTo}
          </Button>
        )}
        <Button
          size="xs"
          variant="outline"
          render={
            <Link to="/kin/$environmentId/$orgId/docs" params={params} search={{ doc: doc.key }} />
          }
        >
          Open
        </Button>
        {doc.previousVersion === null ? null : (
          <Button
            size="xs"
            variant="ghost"
            render={
              <Link
                to="/kin/$environmentId/$orgId/docs"
                params={params}
                search={{ doc: doc.key, changes: doc.version, from: doc.previousVersion }}
              />
            }
          >
            {KIN_DOCS.changes}
          </Button>
        )}
      </div>
    </CardFrame>
  );
}

function KinDigestCard(props: { readonly digest: KinDigestCardView }) {
  const { digest } = props;
  return (
    <CardFrame eyebrow={digest.eyebrow} label={digest.accessibilityLabel}>
      <p className="font-medium text-foreground">{digest.title}</p>
      <ul className="flex flex-col gap-1.5">
        {digest.rows.map((row) => (
          <li key={row.key} className="flex flex-col gap-0.5">
            {row.heading === null ? null : (
              <p className="pt-1 text-xs font-medium text-muted-foreground">{row.heading}</p>
            )}
            <div className="flex items-start gap-2">
              <p className="min-w-0 flex-1 text-foreground">{row.text}</p>
              {row.link === null ? null : (
                <Button
                  size="xs"
                  variant="ghost"
                  aria-label={row.link.label}
                  render={<a href={row.link.url} target="_blank" rel="noreferrer noopener" />}
                >
                  {row.link.chipLabel}
                </Button>
              )}
            </div>
            {row.note === null ? null : <p className="text-xs text-muted-foreground">{row.note}</p>}
          </li>
        ))}
      </ul>
      {digest.more === null ? null : <p className="text-xs text-muted-foreground">{digest.more}</p>}
    </CardFrame>
  );
}

function KinChoiceCard(props: {
  readonly choice: KinChoiceCardView;
  readonly environmentId: EnvironmentId;
  readonly viewerPersonId: KinPersonId | null;
}) {
  const { choice, environmentId } = props;
  const nowMs = useNowMinuteMs();
  const canAct = useAtomValue(kinClient.widgetAction.permissionAtom(environmentId));
  const post = useAtomCommand(kinClient.widgetAction, { reportFailure: false });
  const [taps] = useState(kinChoiceCardTaps);
  const [pending, setPending] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [switchProblem, setSwitchProblem] = useState<string | null>(null);
  const setSendFrom = useAtomCommand(kinClient.connectionSetSendFrom, { reportFailure: false });
  const canEdit = useAtomValue(kinClient.connectionSendEdited.permissionAtom(environmentId));
  const sendEdited = useAtomCommand(kinClient.connectionSendEdited, { reportFailure: false });
  const saveEdited = useAtomCommand(kinClient.connectionSaveEdited, { reportFailure: false });
  const heldKey = kinSendEditHeldKey(environmentId, props.viewerPersonId, choice.widgetId);
  const [editing, setEditing] = useState<KinSendEditing | null>(() => kinSendEditHeld(heldKey));
  const [editBusy, setEditBusy] = useState<KinSendEditBusy>(null);
  // Kept with the editor closed: Edit before the card's update binds to what the host took.
  const [ack, setAck] = useState<KinSendEditAck | null>(null);
  const [lastStatus, setLastStatus] = useState<KinChoiceCardStatus>(null);
  // The try the person ticked they checked the sent mail for; the press reads it when it posts.
  // It counts only while the card's warning names that try (`kinSendTicked`).
  const [ticked, setTicked] = useState<KinSendTry | null>(null);
  const status = visibleKinCardStatus(lastStatus, choice.revision);
  const phase = kinChoicePhase(choice, nowMs);
  const sentOption =
    status?.holding === true
      ? choice.options.find((option) => option.id === lastStatus?.optionId)
      : undefined;

  const answered = kinChoiceAnswered(choice, props.viewerPersonId, sentOption?.label ?? null);
  const editable =
    answered === null && pending === null && kinSendEditOffered(choice, phase, canAct && canEdit);
  const shownEdit = kinSendEditShown(editing, editable) ? editing : null;
  const undone = kinChoiceUndoneLine(choice, props.viewerPersonId, new Date(nowMs));

  const editBound = shownEdit === null ? null : kinSendEditBound(shownEdit, choice);
  // The tick answers the press on screen: the editor's for the words typed, else the card's.
  const warnedView = kinSendEditWarned(choice, shownEdit, new Date(nowMs));
  const checked = kinSendTicked(warnedView, ticked) !== null;

  const { tick, press, pickFrom, sendEdit, saveEdit, discardEdit, dismiss } = kinChoiceCardActions({
    choice,
    environmentId,
    newId: randomUUID,
    taps,
    heldKey,
    state: { pending, switching, editing: shownEdit, editBusy, editable, ticked, nowMs },
    commands: { post, setSendFrom, sendEdited, saveEdited },
    set: {
      pending: setPending,
      lastStatus: setLastStatus,
      switching: setSwitching,
      switchProblem: setSwitchProblem,
      editBusy: setEditBusy,
      editing: setEditing,
      ack: setAck,
      ticked: setTicked,
    },
  });
  const leave = useEffectEvent(() => {
    if (kinSendEditLeaveSaves(shownEdit, editBusy, editable)) void saveEdit(true);
    else if (shownEdit !== null && kinSendEditUnsaved(shownEdit))
      kinSendEditHold(heldKey, shownEdit);
  });
  const editorOpen = shownEdit !== null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- unsaved words are kept when the tab is hidden or the chat is left.
  useEffect(() => {
    if (!editorOpen) return;
    const hidden = () => {
      if (document.visibilityState === "hidden") leave();
    };
    document.addEventListener("visibilitychange", hidden);
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      leave();
    };
  }, [editorOpen]);
  const edited = kinSendEditedLine(choice, props.viewerPersonId);
  const decided = kinChoiceDecidedLine(choice, props.viewerPersonId);
  // A mail's Cancel is asked first, then waits a few seconds for Undo before it is sent.
  const [asking, setAsking] = useState<string | null>(null);
  const [held, setHeld] = useState<string | null>(null);
  const sendHeld = useEffectEvent(() => {
    const optionId = held;
    setHeld(null);
    if (optionId !== null) void press(optionId);
  });
  const [heldPress] = useState(() =>
    createKinHeldPress({
      delayMs: KIN_MAIL_CANCEL_UNDO_MS,
      send: () => sendHeld(),
      timers: kinDeviceTimers,
    }),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a held Cancel is sent when its card leaves the screen.
  useEffect(() => () => heldPress.flush(), [heldPress]);
  const choose = (optionId: string) =>
    kinMailCancels(choice, optionId) ? setAsking(optionId) : void press(optionId);
  const dismissible = canAct && kinChoiceDismissible(choice, phase, props.viewerPersonId);
  const dismissed = kinChoiceDismissedLine(choice, props.viewerPersonId);

  if (phase === "dismissed" && dismissed !== null)
    return (
      <section aria-label={kinSentences([dismissed.text, choice.question])} className="px-1">
        <div className="flex min-h-6 items-center gap-2">
          <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            <span className="font-medium">{dismissed.text}</span> · {choice.question}
          </p>
          {dismissed.undo && canAct ? (
            <Button
              variant="ghost-muted"
              size="xs"
              aria-label={KIN_CHOICE_DISMISS_COPY.undoName}
              aria-busy={pending !== null}
              disabled={pending !== null}
              onClick={() => void dismiss(true)}
            >
              {KIN_CHOICE_DISMISS_COPY.undo}
            </Button>
          ) : null}
        </div>
        <CardNotice notice={status?.notice} />
      </section>
    );

  return (
    <CardFrame label={kinChoiceAccessibilityLabel(choice, answered?.text ?? null, edited)}>
      <KinConfirm
        ask={
          asking === null
            ? null
            : {
                title: KIN_MAIL_CANCEL_COPY.ask,
                detail: KIN_MAIL_CANCEL_COPY.detail,
                action: KIN_MAIL_CANCEL_COPY.yes,
                cancel: KIN_MAIL_CANCEL_COPY.no,
                destructive: true,
              }
        }
        onConfirm={() => {
          setHeld(asking);
          heldPress.hold();
        }}
        onClose={() => setAsking(null)}
      />
      {choice.askedBy === null ? null : (
        <p className="text-xs text-muted-foreground">{choice.askedBy}</p>
      )}
      <p className="font-medium text-foreground">{choice.question}</p>
      {choice.send !== null && shownEdit !== null ? (
        <KinSendEditor
          send={choice.send}
          draft={shownEdit.draft}
          busy={editBusy !== null}
          problem={shownEdit.problem}
          review={editBound?.review === true}
          controls={kinSendEditControls(
            shownEdit,
            choice,
            editBusy,
            editable,
            kinSendCheckPending(warnedView, ticked),
          )}
          onChange={(draft) => setEditing({ ...shownEdit, draft })}
          onSave={() => void saveEdit()}
          onSend={() => void sendEdit()}
          onDiscard={() => void discardEdit()}
        />
      ) : choice.send !== null ? (
        <KinSendDetail
          send={choice.send}
          edited={edited}
          pickFrom={
            phase === "open" && canAct && answered === null && choice.send.fromChoices.length > 1
              ? { busy: switching, problem: switchProblem, pick: (id) => void pickFrom(id) }
              : null
          }
        />
      ) : choice.draft !== null ? (
        <KinChoiceDraft draft={choice.draft} environmentId={environmentId} orgId={choice.orgId} />
      ) : choice.detail === null ? null : (
        <p className="whitespace-pre-line text-xs text-muted-foreground">{choice.detail}</p>
      )}
      {choice.image === null ? null : (
        <KinChoiceImage environmentId={environmentId} image={choice.image} />
      )}
      {warnedView.send?.mayHaveGone == null || answered !== null || phase !== "open" ? null : (
        <KinSendMayHaveGone
          line={warnedView.send.mayHaveGone.line}
          checked={checked}
          disabled={!canAct || pending !== null || editBusy !== null}
          onChange={tick}
        />
      )}
      {answered !== null ? (
        answered.text === null ? null : (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs font-medium text-muted-foreground">{answered.text}</p>
            {choice.outcome?.open == null ? null : (
              <KinChoiceOpenLink
                open={choice.outcome.open}
                environmentId={environmentId}
                orgId={choice.orgId}
              />
            )}
          </div>
        )
      ) : phase === "expired" ? (
        <p className="text-xs text-muted-foreground">{choice.closedText}</p>
      ) : !canAct ? (
        <p className="text-xs text-muted-foreground">{CANT_ACT_TEXT}</p>
      ) : shownEdit !== null ? null : held !== null ? (
        <div className="flex items-center gap-2 pt-1">
          <p role="status" className="min-w-0 flex-1 text-xs font-medium text-muted-foreground">
            {KIN_MAIL_CANCEL_COPY.held}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              heldPress.undo();
              setHeld(null);
            }}
          >
            {KIN_MAIL_CANCEL_COPY.undo}
          </Button>
        </div>
      ) : (
        <>
          <CardNotice notice={status?.notice} />
          <div className="flex flex-col gap-1.5 pt-1">
            {(status?.behind === true ? [] : choice.options).map((option) => (
              <div key={option.id} className="flex flex-col gap-0.5">
                <Button
                  variant="outline"
                  size="sm-multiline"
                  aria-busy={pending === option.id}
                  disabled={
                    pending !== null || switching || kinSendCheckPending(choice, ticked, option.id)
                  }
                  onClick={() => choose(option.id)}
                >
                  {option.label}
                </Button>
                {option.action === null ? null : (
                  <p className="px-1 text-xs text-muted-foreground">{option.action}</p>
                )}
              </div>
            ))}
            {editable && status?.behind !== true ? (
              <Button
                variant="outline"
                size="sm-multiline"
                disabled={switching}
                onClick={() =>
                  setEditing(kinSendEditHeld(heldKey) ?? kinSendEditStart(choice, ack))
                }
              >
                {KIN_SEND_EDIT_COPY.edit}
              </Button>
            ) : null}
          </div>
          {dismissible ? (
            <div className="flex">
              <Button
                variant="ghost-muted"
                size="xs"
                aria-label={KIN_CHOICE_DISMISS_COPY.dismissName}
                aria-busy={
                  pending !== null && choice.options.every((option) => option.id !== pending)
                }
                disabled={pending !== null || switching}
                onClick={() => void dismiss()}
              >
                {KIN_CHOICE_DISMISS_COPY.dismiss}
              </Button>
            </div>
          ) : null}
        </>
      )}
      {decided === null ? null : <p className="text-xs text-muted-foreground">{decided}</p>}
      {undone === null ? null : <p className="text-xs text-muted-foreground">{undone}</p>}
    </CardFrame>
  );
}

/**
 * A mail card's To, Cc, Subject and Body, editable in place; its From, quote and files go as
 * drawn and show here. Only the Send button sends, never Enter in a field.
 */
function KinSendEditor(props: {
  readonly send: NonNullable<KinChoiceCardView["send"]>;
  readonly draft: KinSendEditDraft;
  readonly busy: boolean;
  readonly problem: string | null;
  /** The card changed under the editor: who it goes from now is shown again beside Send. */
  readonly review: boolean;
  readonly controls: ReturnType<typeof kinSendEditControls>;
  readonly onChange: (draft: KinSendEditDraft) => void;
  readonly onSave: () => void;
  readonly onSend: () => void;
  readonly onDiscard: () => void;
}) {
  const { send, draft, busy, controls } = props;
  const id = useId();
  const field = (name: keyof KinSendEditDraft, value: string) =>
    props.onChange({ ...draft, [name]: value });
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">{send.heading}</p>
      {send.from.length === 0 ? null : <KinSendLines lines={send.from} />}
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${id}-to`}>{KIN_SEND_EDIT_COPY.to}</Label>
        <Input
          id={`${id}-to`}
          size="sm"
          value={draft.to}
          autoComplete="off"
          aria-describedby={`${id}-addresses`}
          disabled={busy}
          onChange={(event) => field("to", event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${id}-cc`}>{KIN_SEND_EDIT_COPY.cc}</Label>
        <Input
          id={`${id}-cc`}
          size="sm"
          value={draft.cc}
          autoComplete="off"
          aria-describedby={`${id}-addresses`}
          disabled={busy}
          onChange={(event) => field("cc", event.target.value)}
        />
        <p id={`${id}-addresses`} className="text-xs text-muted-foreground">
          {KIN_SEND_EDIT_COPY.addresses}
        </p>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${id}-subject`}>{KIN_SEND_EDIT_COPY.subject}</Label>
        <Input
          id={`${id}-subject`}
          size="sm"
          value={draft.subject}
          autoComplete="off"
          disabled={busy}
          onChange={(event) => field("subject", event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${id}-body`}>{KIN_SEND_EDIT_COPY.body}</Label>
        <Textarea
          id={`${id}-body`}
          aria-label={KIN_SEND_EDIT_COPY.bodyName}
          rows={8}
          value={draft.body}
          disabled={busy}
          onChange={(event) => field("body", event.target.value)}
        />
      </div>
      {send.quoted === null ? null : (
        <div className="flex flex-col gap-1">
          <KinSendMessage label={KIN_SEND_EDIT_COPY.quotedLabel} body={null} quoted={send.quoted} />
          <p className="text-xs text-muted-foreground">{KIN_SEND_EDIT_COPY.quoted}</p>
        </div>
      )}
      {send.attachments.length === 0 ? null : (
        <div className="flex flex-col gap-1">
          <ul className="flex flex-col gap-1">
            {send.attachments.map((file) => (
              <li key={file.name} className="flex items-start gap-2 text-xs">
                <FileTextIcon
                  aria-hidden
                  className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                />
                <span className="min-w-0 break-words text-foreground">{file.name}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">{KIN_SEND_EDIT_COPY.attachments}</p>
        </div>
      )}
      {props.problem === null ? null : (
        <p role="alert" className="text-xs text-destructive-foreground">
          {props.problem}
        </p>
      )}
      {props.review && props.problem !== null && send.from.length > 0 ? (
        <KinSendLines lines={send.from} />
      ) : null}
      {controls.notice === null ? null : (
        <p role="status" className="text-xs text-muted-foreground">
          {controls.notice}
        </p>
      )}
      <div className="flex flex-col gap-1.5 pt-1">
        <Button
          type="button"
          variant="outline"
          size="sm-multiline"
          aria-busy={controls.save.label === KIN_SEND_EDIT_COPY.saving}
          disabled={controls.save.disabled}
          onClick={props.onSave}
        >
          {controls.save.label}
        </Button>
        <Button
          type="button"
          size="sm-multiline"
          aria-busy={controls.send.label === KIN_SEND_EDIT_COPY.sending}
          disabled={controls.send.disabled}
          onClick={props.onSend}
        >
          {controls.send.label}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm-multiline"
          aria-busy={controls.discard.label === KIN_SEND_EDIT_COPY.discarding}
          disabled={controls.discard.disabled}
          onClick={props.onDiscard}
        >
          {controls.discard.label}
        </Button>
      </div>
    </div>
  );
}

/** An earlier try at this mail may have gone: the closed card's warning, and the tick Confirm needs. */
function KinSendMayHaveGone(props: {
  readonly line: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <p role="status" className="text-xs font-medium text-destructive-foreground">
        {props.line}
      </p>
      <div className="flex items-start gap-2">
        <Checkbox
          id={id}
          checked={props.checked}
          disabled={props.disabled}
          onCheckedChange={(next) => props.onChange(next)}
        />
        <label htmlFor={id} className="cursor-pointer text-xs text-foreground">
          {KIN_SEND_CHECKED}
        </label>
      </div>
    </div>
  );
}

/** A send card's labelled lines; `fromAction` sits at the end of its From line. */
function KinSendLines(props: {
  readonly lines: NonNullable<KinChoiceCardView["send"]>["lines"];
  readonly fromAction?: ReactNode;
}) {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
      {props.lines.map((line) => (
        <div key={line.label} className="contents">
          <dt className="text-muted-foreground">{line.label}</dt>
          <dd className="flex min-w-0 items-start justify-between gap-2">
            <span className="min-w-0 break-words text-foreground">
              <AddressPieces value={line.value} />
            </span>
            {line.label === "From" ? props.fromAction : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** The mail's words as they go, with the earlier message quoted below them. */
function KinSendMessage(props: {
  readonly label: string;
  readonly body: string | null;
  readonly quoted: string | null;
}) {
  return (
    <div
      tabIndex={0}
      aria-label={props.label}
      className="max-h-80 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 px-3 py-2 text-sm text-foreground"
    >
      {props.body}
      {props.quoted === null ? null : (
        <span className={cn("block text-muted-foreground", props.body !== null && "mt-3")}>
          {props.quoted}
        </span>
      )}
    </div>
  );
}

/** Exactly what a send card sends: who, the subject, the whole body and each file. */
/** An address line that may wrap after "@" or a dot (`kinAddressPieces`), never mid-word. */
function AddressPieces(props: { readonly value: string }) {
  let at = 0;
  return kinAddressPieces(props.value).map((piece) => {
    const start = at;
    at += piece.length;
    return (
      <Fragment key={start}>
        {start === 0 ? null : <wbr />}
        {piece}
      </Fragment>
    );
  });
}

function KinSendDetail(props: {
  readonly send: NonNullable<KinChoiceCardView["send"]>;
  /** "Edited by you" while the words shown are a person's saved edit. */
  readonly edited: string | null;
  /** Set while the owner may still switch From. */
  readonly pickFrom: {
    readonly busy: boolean;
    readonly problem: string | null;
    readonly pick: (id: string) => void;
  } | null;
}) {
  const { send, pickFrom } = props;
  const current = send.fromChoices.find((one) => one.current)?.id ?? "";
  const accounts = [...new Set(send.fromChoices.map((one) => one.account))];
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">{send.heading}</p>
      {send.thread === null ? null : (
        <div className="flex flex-col gap-0.5 rounded-md border border-border px-3 py-2 text-xs">
          <p className="font-medium text-foreground">{send.thread.subject}</p>
          <p className="text-muted-foreground">
            Replying to {send.thread.replyingTo}
            {send.thread.date === null ? "" : `, ${send.thread.date}`}
          </p>
          {send.thread.lines === "" ? null : (
            <p className="line-clamp-2 text-foreground">{send.thread.lines}</p>
          )}
        </div>
      )}
      <KinSendLines
        lines={send.lines}
        fromAction={
          pickFrom === null ? null : (
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="xs"
                    variant="ghost"
                    aria-busy={pickFrom.busy}
                    disabled={pickFrom.busy}
                  />
                }
              >
                {pickFrom.busy ? "Changing…" : "Change"}
              </MenuTrigger>
              <MenuPopup align="end" side="bottom">
                <MenuRadioGroup
                  value={current}
                  onValueChange={(value) => pickFrom.pick(String(value))}
                >
                  {accounts.map((account) => (
                    <MenuGroup key={account}>
                      {accounts.length > 1 ? <MenuGroupLabel>{account}</MenuGroupLabel> : null}
                      {send.fromChoices
                        .filter((one) => one.account === account)
                        .map((one) => (
                          <MenuRadioItem key={one.id} value={one.id} closeOnClick>
                            {one.label}
                          </MenuRadioItem>
                        ))}
                    </MenuGroup>
                  ))}
                </MenuRadioGroup>
              </MenuPopup>
            </Menu>
          )
        }
      />
      {pickFrom?.problem == null ? null : (
        <p role="alert" className="text-xs text-destructive-foreground">
          {pickFrom.problem}
        </p>
      )}
      <KinSendMessage label="Message" body={send.body} quoted={send.quoted} />
      {props.edited === null ? null : (
        <p className="text-xs text-muted-foreground">{props.edited}</p>
      )}
      {send.attachments.length === 0 ? null : (
        <ul className="flex flex-col gap-1">
          {send.attachments.map((file) => (
            <li key={file.name} className="flex items-start gap-2 text-xs">
              <FileTextIcon
                aria-hidden
                className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
              />
              <span className="min-w-0">
                <span className="break-words text-foreground">{file.name}</span>
                {file.detail === "" ? null : (
                  <span className="block text-muted-foreground">{file.detail}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {send.noBank === null ? null : (
        <p className="text-xs text-warning-foreground">{send.noBank}</p>
      )}
      {send.outcome === null ? null : (
        <p
          role="status"
          className={cn(
            "text-xs font-medium",
            send.outcome.tone === "error"
              ? "text-destructive-foreground"
              : send.outcome.tone === "ok"
                ? "text-success-foreground"
                : "text-muted-foreground",
          )}
        >
          {send.outcome.text}
        </p>
      )}
    </div>
  );
}

/**
 * The card's picture, such as a logo to confirm, at a bounded size on a mid grey that a white
 * logo and a black one both stand out on. Its bytes load from the viewer's signed asset URL.
 */
/** Opens what a tap made where it lives: a list in Money, Clients or Docs. */
function KinChoiceOpenLink(props: {
  readonly open: KinChoiceOpen;
  readonly environmentId: EnvironmentId;
  readonly orgId: string;
}) {
  const { open } = props;
  const params = { environmentId: props.environmentId, orgId: props.orgId };
  const search: KinPlaceSearch =
    open.subscriptions === true ? { subscriptions: true } : { list: open.list };
  return (
    <Button
      size="xs"
      variant="outline"
      render={
        open.place === "money" ? (
          <Link to="/kin/$environmentId/$orgId/money" params={params} search={search} />
        ) : open.place === "clients" ? (
          <Link to="/kin/$environmentId/$orgId/clients" params={params} search={search} />
        ) : (
          <Link to="/kin/$environmentId/$orgId/docs" params={params} search={search} />
        )
      }
    >
      {KIN_CHOICE_OPEN_LABEL}
    </Button>
  );
}

/** A teammate's sent-up draft, rendered as a doc is; a long one opens under Show all. */
function KinChoiceDraft(props: {
  readonly draft: KinChoiceDraftView;
  readonly environmentId: EnvironmentId;
  readonly orgId: string;
}) {
  const { draft } = props;
  const [open, setOpen] = useState(false);
  const line = (text: string | null) =>
    text === null ? null : (
      <p className="whitespace-pre-line text-xs text-muted-foreground">{text}</p>
    );
  return (
    <>
      {line(draft.before)}
      <div className="rounded-md border border-border px-3 py-2 text-sm">
        <ChatMarkdown
          text={kinBodyMarkdown(draft.folds && !open ? draft.preview : draft.markdown)}
          cwd={undefined}
          environmentId={props.environmentId}
        />
        {draft.folds ? (
          <Button size="xs" variant="ghost" onClick={() => setOpen(!open)}>
            {open ? KIN_CHOICE_DRAFT_COPY.showLess : KIN_CHOICE_DRAFT_COPY.showAll}
          </Button>
        ) : null}
      </div>
      {line(draft.after)}
      {draft.open === null ? null : (
        <div>
          <Button
            size="xs"
            variant="outline"
            render={
              <Link
                to="/kin/$environmentId/$orgId/docs"
                params={{ environmentId: props.environmentId, orgId: props.orgId }}
                search={{ doc: draft.open.key, v: draft.open.version }}
              />
            }
          >
            {KIN_CHOICE_OPEN_LABEL}
          </Button>
        </div>
      )}
    </>
  );
}

function KinChoiceImage(props: {
  readonly environmentId: EnvironmentId;
  readonly image: NonNullable<KinChoiceCardView["image"]>;
}) {
  const { image } = props;
  const name = `image.${image.mimeType.split("/")[1]?.replace("svg+xml", "svg") ?? "png"}`;
  const [src] = useAssetUrls(props.environmentId, [
    {
      _tag: "attachment",
      attachmentId: image.attachmentId,
      fileName: name,
      mimeType: image.mimeType,
    },
  ]);
  const [failed, setFailed] = useState(false);
  return (
    <div className="flex h-28 items-center justify-center overflow-hidden rounded-md border border-border/80 bg-image-ground p-3">
      {failed ? (
        <p className="rounded bg-background/90 px-2 py-1 text-xs text-muted-foreground">
          {KIN_CARD_COPY.pictureFailed}
        </p>
      ) : src == null ? null : (
        <AttachmentImage
          name={name}
          mimeType={image.mimeType}
          src={src}
          alt={KIN_CARD_COPY.choicePicture}
          decoding="async"
          onError={() => setFailed(true)}
          className="max-h-full max-w-full object-contain"
        />
      )}
    </div>
  );
}

function KinDeferralCard(props: {
  readonly deferral: KinDeferralCardView;
  readonly environmentId: EnvironmentId;
}) {
  const { deferral, environmentId } = props;
  const canAct = useAtomValue(kinClient.widgetAction.permissionAtom(environmentId));
  const post = useWidgetPost(environmentId);
  const actions =
    useRef<ReturnType<typeof createKinCardActions<KinDeferralCardView, KinDeferralActionId>>>(null);
  const [pending, setPending] = useState<KinDeferralActionId | null>(null);
  const [lastStatus, setLastStatus] = useState<KinCardStatus | null>(null);
  const status = visibleKinCardStatus(lastStatus, deferral.revision);

  const press = async (actionId: KinDeferralActionId) => {
    if (pending !== null) return;
    if (actions.current === null)
      actions.current = createKinCardActions({
        toInput: kinDeferralActInput,
        failureNotice: kinActionFailureNotice,
        newId: randomUUID,
        post,
      });
    const revision = deferral.revision;
    const outcome = await actions.current(deferral, actionId, () => {
      setPending(actionId);
      setLastStatus(null);
    });
    if (outcome.status === "ignored") return;
    setPending(null);
    setLastStatus(kinCardStatusAfter(outcome, actionId, revision, deferral.agent));
  };

  return (
    <CardFrame eyebrow={deferral.eyebrow} label={deferral.accessibilityLabel}>
      <p className="font-medium text-foreground">{deferral.title}</p>
      {deferral.lines.map((line) => (
        <p key={line} className="text-xs text-muted-foreground">
          {line}
        </p>
      ))}
      {deferral.countdown === null ? null : (
        <KinCountdownLine targetMs={deferral.countdown.to} kind={deferral.countdown.kind} />
      )}
      <CardNotice notice={status?.notice} />
      {deferral.actions.length === 0 ? null : !canAct ? (
        <p className="text-xs text-muted-foreground">{CANT_ACT_TEXT}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {deferral.actions.map((action) => (
            <Button
              key={action.id}
              variant="outline"
              size="sm"
              aria-label={action.accessibilityLabel}
              aria-busy={pending === action.id}
              disabled={status?.holding === true || pending !== null}
              onClick={() => void press(action.id)}
            >
              {action.label}
            </Button>
          ))}
        </div>
      )}
    </CardFrame>
  );
}

/** Reads the shared minute tick only while a countdown shows; never repaints faster. */
function KinCountdownLine(props: {
  readonly targetMs: number;
  readonly kind: Parameters<typeof kinDeferralCountdown>[2];
}) {
  const nowMs = useNowMinuteMs();
  return (
    <p className="text-xs font-medium text-muted-foreground">
      {kinDeferralCountdown(props.targetMs, nowMs, props.kind)}
    </p>
  );
}

function KinMemoryChangesCard(props: {
  readonly changes: KinMemoryChangesCardView;
  readonly environmentId: EnvironmentId;
}) {
  const { changes, environmentId } = props;
  const canUndo = useAtomValue(kinClient.memoryUndo.permissionAtom(environmentId));
  const send = useAtomCommand(kinClient.memoryUndo, { reportFailure: false });
  const [pending, setPending] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ readonly itemId: string; readonly text: string } | null>(
    null,
  );

  const undo = async (item: KinMemoryChangeItemView) => {
    if (pending !== null) return;
    setPending(item.itemId);
    setFailed(null);
    const result = await send({
      environmentId,
      input: { orgId: changes.orgId, widgetId: changes.widgetId, itemId: item.itemId },
    });
    setPending(null);
    if (AsyncResult.isFailure(result))
      setFailed({
        itemId: item.itemId,
        text: kinMemoryUndoFailureText(squashAtomCommandFailure(result)),
      });
  };

  return (
    <CardFrame eyebrow="Memory" label="Memory changes">
      <ul className="flex flex-col gap-1">
        {changes.items.map((item) => {
          const failure = failed?.itemId === item.itemId ? failed.text : null;
          return (
            <li key={item.itemId} className="flex flex-col gap-0.5">
              <div className="flex items-center gap-2">
                <p
                  aria-label={item.accessibilityLabel}
                  className={cn(
                    "min-w-0 flex-1",
                    item.undo === "undone" ? "text-muted-foreground" : "text-foreground",
                  )}
                >
                  {item.line}
                </p>
                {item.undo === "undone" ? (
                  <span className="text-xs font-medium text-muted-foreground">Undone</span>
                ) : item.undo === "stale" ? (
                  <span className="text-xs font-medium text-warning-foreground">Changed since</span>
                ) : canUndo ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    aria-label={`Undo: ${item.line}`}
                    aria-busy={pending === item.itemId}
                    disabled={pending !== null}
                    onClick={() => void undo(item)}
                  >
                    {failure === null ? "Undo" : KIN_RETRY}
                  </Button>
                ) : null}
              </div>
              {failure === null ? null : (
                <p role="alert" className="text-xs font-medium text-destructive-foreground">
                  {failure}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      {changes.more === null ? null : (
        <p className="text-xs text-muted-foreground">{changes.more}</p>
      )}
    </CardFrame>
  );
}

/** Only the phone's approval key signs, so here the card says where it stands and where to go. */
function KinApprovalCard(props: { readonly approval: KinApprovalWidgetView }) {
  const { approval } = props;
  const open = !approval.closed;
  const status = approval.state === null ? null : KIN_APPROVAL_STATE_TEXT[approval.state];
  return (
    <CardFrame
      eyebrow={open ? "Approval needed" : "Approval"}
      label={open ? "Approval needed. Approve on your phone." : `Approval. ${status ?? ""}`}
    >
      {open ? <ApproveOnPhone /> : <p className="text-xs text-muted-foreground">{status}</p>}
    </CardFrame>
  );
}
