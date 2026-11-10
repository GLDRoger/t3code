import { useAtomValue } from "@effect/atom-react";
import {
  KIN_MISSING_CARD_TEXT,
  KIN_UNKNOWN_CARD_TEXT,
  kinCardView,
  type KinDigestCardView,
  type KinTaskCardView,
  type KinTaskTone,
} from "@t3tools/client-runtime/kin/kinCardPresentation";
import {
  KIN_CHOICE_EXPIRED_TEXT,
  kinChoiceAccessibilityLabel,
  kinChoiceActInput,
  kinChoiceAnswerText,
  kinChoicePhase,
  type KinChoiceCardView,
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
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, KinPersonId, KinWidget } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { SmartphoneIcon } from "lucide-react";
import { memo, useRef, useState, type ReactNode } from "react";

import { environmentCatalog } from "../connection/catalog";
import { useNowMinuteMs } from "./useKinClock";
import { cn, randomUUID } from "../lib/utils";
import { useAtomCommand } from "../state/use-atom-command";
import { Button } from "../components/ui/button";
import { PullRequestGlyph } from "../components/pullRequest/pullRequestIcons";
import { kinClient } from "./kinClient";

const CANT_ACT_TEXT =
  "This browser can't answer here. Pair it again with the server that runs Kin.";

function CardFrame(props: {
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

/** The card for a message's widget, drawn from the shared presentation. Never renders HTML. */
export const KinCard = memo(function KinCard(props: {
  readonly widget: KinWidget | undefined;
  readonly environmentId: EnvironmentId;
  readonly viewerPersonId: KinPersonId | null;
}) {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const view = kinCardView(
    props.widget,
    props.environmentId,
    (environmentId) => !catalog.isReady || catalog.entries.has(environmentId),
  );
  switch (view.kind) {
    case "task":
      return <KinTaskCard task={view.task} />;
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
    case "digest":
      return <KinDigestCard digest={view.digest} />;
    case "memory_changes":
      return <KinMemoryChangesCard changes={view.changes} environmentId={props.environmentId} />;
    case "approval":
      return <KinApprovalCard approval={view.approval} />;
    case "missing":
    case "unknown":
      return (
        <CardFrame>
          <p className="text-muted-foreground">
            {view.kind === "missing" ? KIN_MISSING_CARD_TEXT : KIN_UNKNOWN_CARD_TEXT}
          </p>
        </CardFrame>
      );
  }
});

const TONE_CLASSES: Record<KinTaskTone, string> = {
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
      {task.unknownEnvironment ? (
        <p className="text-xs text-muted-foreground">
          That thread is on an environment this browser doesn't know.
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
  const post = useWidgetPost(environmentId);
  const actions = useRef<ReturnType<typeof createKinCardActions<KinChoiceCardView, string>>>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [lastStatus, setLastStatus] = useState<
    (KinCardStatus & { readonly optionId: string }) | null
  >(null);
  const status = visibleKinCardStatus(lastStatus, choice.revision);
  const phase = kinChoicePhase(choice, nowMs);
  const sentOption =
    status?.holding === true
      ? choice.options.find((option) => option.id === lastStatus?.optionId)
      : undefined;

  const press = async (optionId: string) => {
    if (pending !== null) return;
    if (actions.current === null)
      actions.current = createKinCardActions<KinChoiceCardView, string>({
        newId: randomUUID,
        toInput: kinChoiceActInput,
        post,
      });
    const revision = choice.revision;
    const outcome = await actions.current(choice, optionId, () => {
      setPending(optionId);
      setLastStatus(null);
    });
    if (outcome.status === "ignored") return;
    setPending(null);
    setLastStatus(
      outcome.status === "failed"
        ? { revision, optionId, notice: outcome.notice, holding: false }
        : { revision, optionId, notice: null, holding: true },
    );
  };

  const answerText =
    choice.answer !== null
      ? kinChoiceAnswerText(choice.answer, props.viewerPersonId)
      : sentOption !== undefined
        ? `You chose “${sentOption.label}”`
        : null;

  return (
    <CardFrame label={kinChoiceAccessibilityLabel(choice, answerText)}>
      <p className="font-medium text-foreground">{choice.question}</p>
      {choice.detail === null ? null : (
        <p className="whitespace-pre-line text-xs text-muted-foreground">{choice.detail}</p>
      )}
      {answerText !== null ? (
        <p className="text-xs font-medium text-muted-foreground">{answerText}</p>
      ) : phase === "expired" ? (
        <p className="text-xs text-muted-foreground">{KIN_CHOICE_EXPIRED_TEXT}</p>
      ) : !canAct ? (
        <p className="text-xs text-muted-foreground">{CANT_ACT_TEXT}</p>
      ) : (
        <>
          <CardNotice notice={status?.notice} />
          <div className="flex flex-col gap-1.5 pt-1">
            {choice.options.map((option) => (
              <Button
                key={option.id}
                variant="outline"
                size="sm-multiline"
                aria-busy={pending === option.id}
                disabled={pending !== null}
                onClick={() => void press(option.id)}
              >
                {option.label}
              </Button>
            ))}
          </div>
        </>
      )}
    </CardFrame>
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
    setLastStatus(kinCardStatusAfter(outcome, actionId, revision));
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
                    {failure === null ? "Undo" : "Try again"}
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

/** Approvals need the phone's device key, so the browser points there instead. */
export function ApproveOnPhone() {
  return (
    <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
      <SmartphoneIcon aria-hidden className="size-3.5" />
      Approve on your phone
    </p>
  );
}
