import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import { kinListSend } from "@t3tools/client-runtime/kin/kinLists";
import {
  KIN_MAIL_RULES as COPY,
  KIN_MAIL_RULES_IDLE,
  KIN_MAIL_RULE_HISTORY_IDLE,
  kinMailRuleActions,
  kinMailRuleBreaks,
  kinMailRuleHistoryRows,
  kinMailRulePageView,
  kinMailRulePermissions,
  kinMailRulePreviewView,
  kinMailRuleResumeSend,
  kinMailRuleRowView,
  kinMailRuleRunNowAnswer,
  kinMailRulesRead,
  type KinMailRuleLead,
  type KinMailRuleLineView,
} from "@t3tools/client-runtime/kin/kinMailRules";
import type {
  EnvironmentId,
  KinAgentId,
  KinLeadsListResult,
  KinMailRule,
  KinOrgId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState } from "react";

import { useSearchableSetting } from "../../components/settings/settingsSearch";
import { Button } from "../../components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { randomUUID } from "../../lib/utils";
import { useAtomCommand } from "../../state/use-atom-command";
import { KinConfirm } from "../KinConfirm";
import { kinClient } from "../kinClient";
import { useNowMinuteMs } from "../useKinClock";
import { kinHostConnected } from "../useKinHost";
import {
  KinSettingsEmpty,
  KinSettingsFacts,
  KinSettingsLoadFailed,
  KinSettingsLoading,
  KinSettingsPage,
  KinSettingsRow,
  KinSettingsSection,
  KinSettingsShowAll,
  KinSettingsStatus,
} from "./KinSettingsLayout";

type Target = { readonly environmentId: EnvironmentId; readonly orgId: KinOrgId };

const HISTORY_FIRST = 20;
const NO_LEADS: Atom.Atom<AsyncResult.AsyncResult<KinLeadsListResult, unknown>> = Atom.make(
  AsyncResult.initial(),
);

/** Each piece of `text` with where it starts, for a key that stays put. */
function piecesOf(text: string) {
  const pieces: Array<{ readonly start: number; readonly part: string }> = [];
  let start = 0;
  for (const part of kinMailRuleBreaks(text)) {
    pieces.push({ start, part });
    start += part.length;
  }
  return pieces;
}

/** An address or domain broken only after `@` and `.`, never cut. */
function Breakable(props: { readonly text: string }) {
  return (
    <>
      {piecesOf(props.text).map(({ start, part }) => (
        <span key={start}>
          {start === 0 ? null : <wbr />}
          {part}
        </span>
      ))}
    </>
  );
}

function useMailRulePermissions(environmentId: EnvironmentId) {
  const list = useAtomValue(kinClient.mailRulesList.permissionStateAtom(environmentId));
  const can = kinMailRulePermissions({
    list,
    pause: useAtomValue(kinClient.mailRulePause.permissionAtom(environmentId)),
    resume: useAtomValue(kinClient.mailRuleResume.permissionAtom(environmentId)),
    remove: useAtomValue(kinClient.mailRuleRemove.permissionAtom(environmentId)),
    history: useAtomValue(kinClient.mailRuleHistoryRead.permissionAtom(environmentId)),
    preview: useAtomValue(kinClient.mailRulePreview.permissionAtom(environmentId)),
    runNow: useAtomValue(kinClient.mailRuleRunNow.permissionAtom(environmentId)),
  });
  return { list, can };
}

/** Every lead, retired ones too, for names; only the owner level reads it, as here. */
function useMailRuleLeads(target: Target, ready: boolean): ReadonlyArray<KinMailRuleLead> {
  const result = useAtomValue(ready ? kinClient.agents(target) : NO_LEADS);
  return Option.getOrNull(AsyncResult.value(result))?.leads ?? [];
}

/** Pause, Resume (asking which lead when it must) and Remove (asking once), for list and page. */
function useMailRuleControls(
  target: Target,
  leads: ReadonlyArray<KinMailRuleLead>,
  /** Rules aren't pushed: after any answer the list is read again. */
  reload: () => void,
  onRemoved?: () => void,
) {
  const { environmentId, orgId } = target;
  const pauseCommand = useAtomCommand(kinClient.mailRulePause, { reportFailure: false });
  const removeCommand = useAtomCommand(kinClient.mailRuleRemove, { reportFailure: false });
  const resumeCommand = useAtomCommand(kinClient.mailRuleResume, { reportFailure: false });
  const openChat = useAtomCommand(kinClient.chatWithAgent, { reportFailure: false });
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [removing, setRemoving] = useState<KinMailRule | null>(null);
  const [resuming, setResuming] = useState<KinMailRule | null>(null);
  const [chosen, setChosen] = useState<KinAgentId | null>(null);
  const online = () => kinHostConnected(environmentId);
  const active = leads.filter((lead) => lead.retired === undefined);

  const settle = async (
    rule: KinMailRule,
    failed: string,
    send: () => Promise<{ readonly ok: true } | { readonly ok: false; readonly problem: string }>,
  ) => {
    setBusy(rule.ruleId);
    setProblem(null);
    const outcome = await send();
    setBusy(null);
    reload();
    if (!outcome.ok) setProblem(outcome.problem || failed);
    return outcome.ok;
  };
  const pause = (rule: KinMailRule) =>
    void settle(rule, COPY.pauseFailed, () =>
      kinListSend({
        online,
        send: () => pauseCommand({ environmentId, input: { orgId, ruleId: rule.ruleId } }),
      }),
    );
  const askResume = (rule: KinMailRule) => {
    const own = active.find((lead) => lead.agentId === rule.agentId);
    setChosen(rule.pausedWhy === "agent" || own === undefined ? null : rule.agentId);
    setResuming(rule);
  };
  const resumingLead = resuming === null ? null : active.find((one) => one.agentId === chosen);
  const mustChoose =
    resuming !== null &&
    (resuming.pausedWhy === "agent" || !active.some((lead) => lead.agentId === resuming.agentId));

  const dialogs = (
    <>
      <KinConfirm
        ask={
          removing === null
            ? null
            : {
                title: COPY.removeTitle,
                detail: COPY.removeDetail,
                action: COPY.removeConfirm,
                destructive: true,
              }
        }
        onConfirm={() => {
          if (removing === null) return;
          const rule = removing;
          void settle(rule, COPY.removeFailed, () =>
            kinListSend({
              online,
              send: () => removeCommand({ environmentId, input: { orgId, ruleId: rule.ruleId } }),
            }),
          ).then((ok) => {
            if (ok) onRemoved?.();
          });
        }}
        onClose={() => setRemoving(null)}
      />
      <KinConfirm
        ask={
          resuming === null
            ? null
            : {
                title: COPY.resumeTitle,
                detail: mustChoose
                  ? active.length === 0
                    ? COPY.resumeNoLeads
                    : COPY.resumeChoose
                  : COPY.resumeDetail(resumingLead?.name ?? COPY.goneLead),
                action: COPY.resume,
              }
        }
        notReady={resumingLead == null}
        onConfirm={() => {
          if (resuming === null || resumingLead == null) return;
          const rule = resuming;
          const agentId = resumingLead.agentId as KinAgentId;
          void settle(rule, COPY.resumeFailed, () =>
            kinMailRuleResumeSend({
              rule,
              agentId,
              newId: randomUUID,
              online,
              openChat: (input) => openChat({ environmentId, input }),
              resume: (input) => resumeCommand({ environmentId, input }),
            }),
          );
        }}
        onClose={() => setResuming(null)}
      >
        {mustChoose && active.length > 0 ? (
          <Select
            items={active.map((lead) => ({ value: lead.agentId, label: lead.name }))}
            value={chosen}
            onValueChange={(value) => setChosen(value as KinAgentId | null)}
          >
            <SelectTrigger aria-label={COPY.leadLabel}>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {active.map((lead) => (
                <SelectItem key={lead.agentId} value={lead.agentId}>
                  {lead.name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : null}
      </KinConfirm>
    </>
  );
  return { busy, problem, pause, askResume, askRemove: setRemoving, dialogs };
}

function statusOf(tone: "ok" | "quiet" | "attention" | "error", label: string) {
  return tone === "ok" ? null : <KinSettingsStatus tone={tone}>{label}</KinSettingsStatus>;
}

function Lines(props: { readonly lines: ReadonlyArray<string | null> }) {
  return (
    <>
      {props.lines.flatMap((line) =>
        line === null
          ? []
          : [
              <span key={line} className="block">
                {line}
              </span>,
            ],
      )}
    </>
  );
}

/**
 * Settings → Connections → a company mailbox → Rules: one line per rule, with Pause, Resume and
 * Remove, for the owner level only. Absent for a teammate and on a host that predates rules.
 */
export function KinMailRulesBlock(
  props: Target & {
    readonly connectionId: string;
    readonly onOpen: (ruleId: string) => void;
  },
) {
  const { environmentId, orgId, connectionId } = props;
  const searchId = useSearchableSetting()("kin-mail-rules").id;
  const { list, can } = useMailRulePermissions(environmentId);
  const listAtom = kinClient.mailRules({ environmentId, input: { orgId, connectionId } });
  const result = useAtomValue(can.ready ? listAtom : KIN_MAIL_RULES_IDLE);
  const reload = useAtomRefresh(listAtom);
  const leads = useMailRuleLeads(props, can.ready);
  const controls = useMailRuleControls(props, leads, reload);
  const now = useNowMinuteMs();
  const block = kinMailRulesRead(list, result);
  if (block._tag === "absent") return null;

  return (
    <>
      <KinSettingsSection
        title={COPY.title}
        description={COPY.description}
        searchId={searchId}
        problem={controls.problem}
      >
        {block._tag === "loading" ? (
          <KinSettingsLoading rows={2} />
        ) : block._tag === "failed" ? (
          <KinSettingsLoadFailed onRetry={reload}>{block.text}</KinSettingsLoadFailed>
        ) : block._tag === "empty" ? (
          <KinSettingsEmpty>{`${COPY.emptyTitle}. ${COPY.empty}`}</KinSettingsEmpty>
        ) : (
          block.rules.map((rule) => {
            const row = kinMailRuleRowView(rule, { leads, now });
            const actions = kinMailRuleActions(rule, can);
            const busy = controls.busy !== null;
            return (
              <KinSettingsRow
                key={rule.ruleId}
                wrap
                stack
                title={<Breakable text={row.title} />}
                detail={<Lines lines={[row.does, row.state.detail, row.counts]} />}
                status={statusOf(row.state.tone, row.state.label)}
                openLabel={`${COPY.open}: ${row.title}`}
                {...(actions.open ? { onOpen: () => props.onOpen(rule.ruleId) } : {})}
                control={
                  actions.pause || actions.resume || actions.remove ? (
                    <>
                      {actions.pause ? (
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={busy}
                          onClick={() => controls.pause(rule)}
                        >
                          {COPY.pause}
                        </Button>
                      ) : null}
                      {actions.resume ? (
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={busy}
                          onClick={() => controls.askResume(rule)}
                        >
                          {COPY.resume}
                        </Button>
                      ) : null}
                      {actions.remove ? (
                        <Button
                          size="xs"
                          variant="destructive-outline"
                          disabled={busy}
                          onClick={() => controls.askRemove(rule)}
                        >
                          {COPY.remove}
                        </Button>
                      ) : null}
                    </>
                  ) : undefined
                }
              />
            );
          })
        )}
      </KinSettingsSection>
      {controls.dialogs}
    </>
  );
}

type Asked<A> =
  | { readonly _tag: "idle" }
  | { readonly _tag: "busy" }
  | { readonly _tag: "done"; readonly value: A }
  | { readonly _tag: "failed"; readonly text: string };

function LineRows(props: { readonly rows: ReadonlyArray<KinMailRuleLineView> }) {
  return (
    <>
      {props.rows.map((row) => (
        <KinSettingsRow
          key={row.key}
          wrap
          title={<Breakable text={row.title} />}
          detail={row.detail ?? undefined}
        />
      ))}
    </>
  );
}

/** One rule's own page: its words whole, who set it, its limit, Run now, Preview and its runs. */
export function KinMailRulePage(
  props: Target & {
    readonly connectionId: string;
    readonly ruleId: string;
    /** The mailbox's address, as its row says it. */
    readonly mailbox: string;
    readonly onGone: () => void;
  },
) {
  const { environmentId, orgId, connectionId, ruleId } = props;
  const { list, can } = useMailRulePermissions(environmentId);
  const listAtom = kinClient.mailRules({ environmentId, input: { orgId, connectionId } });
  const result = useAtomValue(can.ready ? listAtom : KIN_MAIL_RULES_IDLE);
  const reload = useAtomRefresh(listAtom);
  const leads = useMailRuleLeads(props, can.ready);
  const controls = useMailRuleControls(props, leads, reload, props.onGone);
  const now = useNowMinuteMs();
  const block = kinMailRulesRead(list, result);
  const rule =
    block._tag === "ready" ? (block.rules.find((one) => one.ruleId === ruleId) ?? null) : null;
  const actions = rule === null ? null : kinMailRuleActions(rule, can);
  const historyAtom = kinClient.mailRuleHistory({ environmentId, input: { orgId, ruleId } });
  const history = useAtomValue(
    actions?.history === true ? historyAtom : KIN_MAIL_RULE_HISTORY_IDLE,
  );
  const reloadHistory = useAtomRefresh(historyAtom);
  const previewCommand = useAtomCommand(kinClient.mailRulePreview, { reportFailure: false });
  const runNowCommand = useAtomCommand(kinClient.mailRuleRunNow, { reportFailure: false });
  const [preview, setPreview] = useState<Asked<ReturnType<typeof kinMailRulePreviewView>>>({
    _tag: "idle",
  });
  const [ran, setRan] = useState<Asked<string>>({ _tag: "idle" });
  const [allRuns, setAllRuns] = useState(false);
  const online = () => kinHostConnected(environmentId);

  if (block._tag === "absent") return null;
  if (block._tag === "loading")
    return (
      <KinSettingsPage>
        <KinSettingsSection>
          <KinSettingsLoading rows={4} />
        </KinSettingsSection>
      </KinSettingsPage>
    );
  if (block._tag === "failed")
    return (
      <KinSettingsPage>
        <KinSettingsSection>
          <KinSettingsLoadFailed onRetry={reload}>{block.text}</KinSettingsLoadFailed>
        </KinSettingsSection>
      </KinSettingsPage>
    );
  if (rule === null || actions === null)
    return (
      <KinSettingsPage>
        <KinSettingsSection>
          <KinSettingsEmpty
            action={
              <Button size="xs" variant="outline" onClick={props.onGone}>
                {COPY.backToMailbox}
              </Button>
            }
          >
            {COPY.gone}
          </KinSettingsEmpty>
        </KinSettingsSection>
      </KinSettingsPage>
    );

  const view = kinMailRulePageView(rule, { leads, mailbox: props.mailbox, now });
  const runPreview = async () => {
    setPreview({ _tag: "busy" });
    const sent = await kinListSend({
      online,
      send: () => previewCommand({ environmentId, input: { orgId, ruleId } }),
    });
    setPreview(
      sent.ok
        ? { _tag: "done", value: kinMailRulePreviewView(sent.value, { now }) }
        : { _tag: "failed", text: sent.problem || COPY.previewFailed },
    );
  };
  const runNow = async () => {
    setRan({ _tag: "busy" });
    const sent = await kinListSend({
      online,
      send: () => runNowCommand({ environmentId, input: { orgId, ruleId } }),
    });
    if (!sent.ok) return setRan({ _tag: "failed", text: sent.problem || COPY.runNowFailed });
    const answer = kinMailRuleRunNowAnswer(sent.value);
    setRan({ _tag: "done", value: answer.text });
    if (answer.ran) reloadHistory();
  };
  const runs =
    history._tag === "Success" ? kinMailRuleHistoryRows(history.value.entries, { now }) : [];
  const shownRuns = allRuns ? runs : runs.slice(0, HISTORY_FIRST);
  const busy = controls.busy !== null;

  return (
    <KinSettingsPage purpose={view.state.detail ?? undefined}>
      <KinSettingsSection
        title={COPY.matchesTitle}
        action={statusOf(view.state.tone, view.state.label) ?? undefined}
      >
        <KinSettingsFacts
          facts={view.facts.map((fact) => ({
            label: fact.label,
            value: <Breakable text={fact.value} />,
          }))}
        />
      </KinSettingsSection>

      <KinSettingsSection title={COPY.pageWhat}>
        <p className="whitespace-pre-line px-4 py-3 text-sm text-foreground">
          <Breakable text={view.what} />
        </p>
      </KinSettingsSection>

      {actions.runNow ? (
        <KinSettingsSection
          title={COPY.runNowTitle}
          problem={ran._tag === "failed" ? ran.text : null}
        >
          <KinSettingsRow
            wrap
            title={COPY.runNowDescription}
            detail={ran._tag === "done" ? <span role="status">{ran.value}</span> : undefined}
            control={
              <Button
                size="sm"
                variant="outline"
                disabled={ran._tag === "busy"}
                aria-busy={ran._tag === "busy"}
                onClick={() => void runNow()}
              >
                {ran._tag === "busy" ? COPY.running : COPY.runNow}
              </Button>
            }
          />
        </KinSettingsSection>
      ) : null}

      {actions.preview ? (
        <KinSettingsSection
          title={COPY.previewTitle}
          description={COPY.previewDescription}
          action={
            <Button
              size="xs"
              variant="outline"
              disabled={preview._tag === "busy"}
              aria-busy={preview._tag === "busy"}
              onClick={() => void runPreview()}
            >
              {preview._tag === "busy" ? COPY.previewing : COPY.preview}
            </Button>
          }
          problem={preview._tag === "failed" ? preview.text : null}
        >
          {preview._tag === "busy" ? (
            <KinSettingsLoading rows={3} />
          ) : preview._tag === "done" ? (
            <>
              {preview.value.empty === null ? null : (
                <KinSettingsEmpty>{preview.value.empty}</KinSettingsEmpty>
              )}
              <LineRows rows={preview.value.rows} />
              {preview.value.note === null ? null : (
                <KinSettingsRow wrap title={preview.value.note} />
              )}
            </>
          ) : (
            <KinSettingsEmpty>{COPY.previewIdle}</KinSettingsEmpty>
          )}
        </KinSettingsSection>
      ) : null}

      {actions.history ? (
        <KinSettingsSection title={COPY.historyTitle}>
          {history._tag === "Initial" ? (
            <KinSettingsLoading rows={3} />
          ) : history._tag === "Failure" ? (
            <KinSettingsLoadFailed onRetry={reloadHistory}>
              {kinFailureText(history.cause, COPY.historyFailed)}
            </KinSettingsLoadFailed>
          ) : runs.length === 0 ? (
            <KinSettingsEmpty>{COPY.historyEmpty}</KinSettingsEmpty>
          ) : (
            <>
              <LineRows rows={shownRuns} />
              {shownRuns.length < runs.length ? (
                <KinSettingsShowAll
                  label={COPY.historyShowAll(runs.length)}
                  onShow={() => setAllRuns(true)}
                />
              ) : null}
            </>
          )}
        </KinSettingsSection>
      ) : null}

      {actions.pause || actions.resume || actions.remove ? (
        <KinSettingsSection title={COPY.actionsTitle} problem={controls.problem}>
          {actions.pause ? (
            <KinSettingsRow
              wrap
              title={COPY.pauseRow}
              control={
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => controls.pause(rule)}
                >
                  {COPY.pause}
                </Button>
              }
            />
          ) : null}
          {actions.resume ? (
            <KinSettingsRow
              wrap
              title={COPY.resumeRow}
              control={
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => controls.askResume(rule)}
                >
                  {COPY.resume}
                </Button>
              }
            />
          ) : null}
          {actions.remove ? (
            <KinSettingsRow
              wrap
              title={COPY.removeRow}
              control={
                <Button
                  size="sm"
                  variant="destructive-outline"
                  disabled={busy}
                  onClick={() => controls.askRemove(rule)}
                >
                  {COPY.remove}
                </Button>
              }
            />
          ) : null}
        </KinSettingsSection>
      ) : null}
      {controls.dialogs}
    </KinSettingsPage>
  );
}
