import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import { kinListSend } from "@t3tools/client-runtime/kin/kinLists";
import {
  KIN_MAIL_RULES as COPY,
  KIN_MAIL_RULES_IDLE,
  KIN_MAIL_RULE_HISTORY_IDLE,
  kinMailRuleActions,
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
  KinConnectionId,
  KinLeadsListResult,
  KinMailRule,
  KinOrgId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState, type ReactNode } from "react";
import { View } from "react-native";

import { AppBar } from "../../../components/ui/AppBar";
import { AppText as Text } from "../../../components/ui/AppText";
import * as Dialog from "../../../components/ui/Dialog";
import { ErrorBanner } from "../../../components/ui/ErrorBanner";
import { ListActionRow } from "../../../components/ui/ListActionRow";
import { ListChoiceRow } from "../../../components/ui/ListChoiceRow";
import { ListRow } from "../../../components/ui/ListRow";
import { ListRowLayout } from "../../../components/ui/ListRowLayout";
import { ListSection } from "../../../components/ui/ListSection";
import { ScreenContent } from "../../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../../components/ui/ScreenScrollView";
import { useNowMinuteMs } from "../../../lib/clock";
import { uuidv4 } from "../../../lib/uuid";
import { useAtomCommand } from "../../../state/use-atom-command";
import { SettingsRow } from "../../settings/components/SettingsRow";
import { KinWorkLoading } from "../components/KinWorkPieces";
import { kinClient, retryKinAccess } from "../state/kinClient";
import { kinHostConnected } from "../state/useKinHost";
import { kinMailRulePhoneLines, kinPhoneBreakable } from "./kinMailRuleText";
import {
  decodeConnectionId,
  decodeConnectionsTarget,
  KinConnectionsMissing,
  type KinConnectionsParams,
} from "./kinConnectionTarget";

type Target = { readonly environmentId: EnvironmentId; readonly orgId: KinOrgId };
export type KinMailRuleParams = KinConnectionsParams & {
  readonly connectionId: string;
  readonly ruleId: string;
};

const HISTORY_FIRST = 20;
const NO_LEADS: Atom.Atom<AsyncResult.AsyncResult<KinLeadsListResult, unknown>> = Atom.make(
  AsyncResult.initial(),
);

const breakable = kinPhoneBreakable;

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

function useMailRuleLeads(target: Target, ready: boolean): ReadonlyArray<KinMailRuleLead> {
  const result = useAtomValue(ready ? kinClient.agents(target) : NO_LEADS);
  return Option.getOrNull(AsyncResult.value(result))?.leads ?? [];
}

/** One company's rules, or one mailbox's, with the block's state. */
function useMailRules(target: Target, connectionId: string | undefined) {
  const { list, can } = useMailRulePermissions(target.environmentId);
  const listAtom = kinClient.mailRules({
    environmentId: target.environmentId,
    input:
      connectionId === undefined ? { orgId: target.orgId } : { orgId: target.orgId, connectionId },
  });
  const result = useAtomValue(can.ready ? listAtom : KIN_MAIL_RULES_IDLE);
  const reload = useAtomRefresh(listAtom);
  const leads = useMailRuleLeads(target, can.ready);
  return { block: kinMailRulesRead(list, result), can, reload, leads };
}

function RuleRows(props: {
  readonly target: Target;
  readonly rules: ReadonlyArray<KinMailRule>;
  readonly leads: ReadonlyArray<KinMailRuleLead>;
}) {
  const navigation = useNavigation();
  const now = useNowMinuteMs();
  return (
    <>
      {props.rules.map((rule) => {
        const row = kinMailRuleRowView(rule, { leads: props.leads, now });
        return (
          <ListRow
            key={rule.ruleId}
            label={breakable(row.title)}
            description={kinMailRulePhoneLines(row)}
            {...(row.state.tone === "ok" ? {} : { detail: row.state.label })}
            onPress={() =>
              navigation.navigate("KinMailRule", {
                environmentId: props.target.environmentId,
                orgId: props.target.orgId,
                connectionId: rule.connectionId,
                ruleId: rule.ruleId,
              })
            }
          />
        );
      })}
    </>
  );
}

/** A company mailbox's Rules on its Connection screen; absent for a teammate or an older host. */
export function KinMailRulesSection(props: Target & { readonly connectionId: string }) {
  const { block, reload, leads } = useMailRules(props, props.connectionId);
  if (block._tag === "absent") return null;
  return (
    <ListSection title={COPY.title} footer={block._tag === "empty" ? COPY.empty : COPY.description}>
      {block._tag === "loading" ? (
        <KinWorkLoading label={COPY.loading} />
      ) : block._tag === "failed" ? (
        <ListActionRow label={block.text} tone="danger" onPress={reload} />
      ) : block._tag === "empty" ? (
        <View className="bg-grouped-card">
          <ListRowLayout label={COPY.emptyTitle} />
        </View>
      ) : (
        <RuleRows target={props} rules={block.rules} leads={leads} />
      )}
    </ListSection>
  );
}

/** Settings → Company → Mail rules: shown to the owner level unless the host predates rules. */
export function KinMailRulesSettingsRow(props: Target) {
  const navigation = useNavigation();
  const { block } = useMailRules(props, undefined);
  if (block._tag === "absent") return null;
  return (
    <SettingsRow
      labelWholeWords
      icon="envelope.badge"
      label={COPY.allTitle}
      onPress={() => navigation.navigate("KinMailRules", props)}
    />
  );
}

/** Every company mailbox's rules, one section per mailbox, from Settings on the phone. */
export function KinMailRulesScreen({ route }: StaticScreenProps<KinConnectionsParams>) {
  const target = decodeConnectionsTarget(route.params);
  return target === null ? (
    <KinConnectionsMissing title={COPY.allTitle} />
  ) : (
    <AllRules target={target} />
  );
}

function AllRules(props: { readonly target: Target }) {
  const navigation = useNavigation();
  const { target } = props;
  const { block, reload, leads } = useMailRules(target, undefined);
  const connections = Option.getOrNull(
    AsyncResult.value(
      useAtomValue(
        kinClient.connections({
          environmentId: target.environmentId,
          input: { orgId: target.orgId },
        }),
      ),
    ),
  );
  const mailboxName = (connectionId: string) => {
    const found = connections?.connections.find((one) => one.connectionId === connectionId);
    return found === undefined ? COPY.goneMailbox : (found.accountLabel ?? found.label);
  };
  const mailboxes =
    block._tag === "ready"
      ? [...new Set(block.rules.map((rule) => rule.connectionId))].map((connectionId) => ({
          connectionId,
          name: mailboxName(connectionId),
          rules: block.rules.filter((rule) => rule.connectionId === connectionId),
        }))
      : [];
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar title={COPY.allTitle} onBack={() => navigation.goBack()} />
      <ScreenContent surface="screen">
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 20 }}
        >
          <Text textRole="footnote" className="px-2 text-foreground-muted">
            {COPY.allDescription}
          </Text>
          {block._tag === "absent" ? (
            <ListSection>
              <View className="bg-grouped-card">
                <ListRowLayout label={COPY.notHere} />
              </View>
            </ListSection>
          ) : block._tag === "loading" ? (
            <KinWorkLoading label={COPY.loading} />
          ) : block._tag === "failed" ? (
            <ListSection>
              <ListActionRow
                label={block.text}
                tone="danger"
                onPress={() => {
                  retryKinAccess(target.environmentId);
                  reload();
                }}
              />
            </ListSection>
          ) : block._tag === "empty" ? (
            <ListSection footer={COPY.empty}>
              <View className="bg-grouped-card">
                <ListRowLayout label={COPY.emptyTitle} />
              </View>
            </ListSection>
          ) : (
            mailboxes.map((mailbox) => (
              <ListSection key={mailbox.connectionId} title={breakable(mailbox.name)}>
                <RuleRows target={target} rules={mailbox.rules} leads={leads} />
              </ListSection>
            ))
          )}
        </ScreenScrollView>
      </ScreenContent>
    </View>
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
        <View key={row.key} accessible className="bg-grouped-card">
          <ListRowLayout
            label={breakable(row.title)}
            {...(row.detail === null ? {} : { description: row.detail })}
          />
        </View>
      ))}
    </>
  );
}

/** One rule: its words whole, who set it, its limit, Run now, Preview, its runs and its controls. */
export function KinMailRuleScreen({ route }: StaticScreenProps<KinMailRuleParams>) {
  const target = decodeConnectionsTarget(route.params);
  const connectionId = decodeConnectionId(route.params);
  return target === null || connectionId === null ? (
    <KinConnectionsMissing title={COPY.pageTitle} />
  ) : (
    <RulePage target={target} connectionId={connectionId} ruleId={route.params.ruleId} />
  );
}

function RulePage(props: {
  readonly target: Target;
  readonly connectionId: KinConnectionId;
  readonly ruleId: string;
}) {
  const navigation = useNavigation();
  const { target, connectionId, ruleId } = props;
  const { environmentId, orgId } = target;
  const { block, can, reload, leads } = useMailRules(target, connectionId);
  // Rules aren't pushed: after any answer both lists a rule shows in are read again.
  const reloadAll = useAtomRefresh(kinClient.mailRules({ environmentId, input: { orgId } }));
  const now = useNowMinuteMs();
  const rule =
    block._tag === "ready" ? (block.rules.find((one) => one.ruleId === ruleId) ?? null) : null;
  const actions = rule === null ? null : kinMailRuleActions(rule, can);
  const historyAtom = kinClient.mailRuleHistory({ environmentId, input: { orgId, ruleId } });
  const history = useAtomValue(
    actions?.history === true ? historyAtom : KIN_MAIL_RULE_HISTORY_IDLE,
  );
  const reloadHistory = useAtomRefresh(historyAtom);
  const connection = Option.getOrNull(
    AsyncResult.value(
      useAtomValue(kinClient.connection({ environmentId, input: { orgId, connectionId } })),
    ),
  );
  const pauseCommand = useAtomCommand(kinClient.mailRulePause, { reportFailure: false });
  const removeCommand = useAtomCommand(kinClient.mailRuleRemove, { reportFailure: false });
  const resumeCommand = useAtomCommand(kinClient.mailRuleResume, { reportFailure: false });
  const openChat = useAtomCommand(kinClient.chatWithAgent, { reportFailure: false });
  const previewCommand = useAtomCommand(kinClient.mailRulePreview, { reportFailure: false });
  const runNowCommand = useAtomCommand(kinClient.mailRuleRunNow, { reportFailure: false });
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [chosen, setChosen] = useState<KinAgentId | null>(null);
  const [preview, setPreview] = useState<Asked<ReturnType<typeof kinMailRulePreviewView>>>({
    _tag: "idle",
  });
  const [ran, setRan] = useState<Asked<string>>({ _tag: "idle" });
  const [allRuns, setAllRuns] = useState(false);
  const online = () => kinHostConnected(environmentId);
  const frame = (children: ReactNode) => (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar title={COPY.pageTitle} onBack={() => navigation.goBack()} />
      <ScreenContent surface="screen">
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 20 }}
        >
          {children}
        </ScreenScrollView>
      </ScreenContent>
    </View>
  );

  if (block._tag === "loading") return frame(<KinWorkLoading label={COPY.loading} />);
  if (block._tag === "failed")
    return frame(
      <ListSection>
        <ListActionRow label={block.text} tone="danger" onPress={reload} />
      </ListSection>,
    );
  if (block._tag === "absent" || rule === null || actions === null)
    return frame(
      <ListSection>
        <View className="bg-grouped-card">
          <ListRowLayout label={block._tag === "absent" ? COPY.notHere : COPY.gone} />
        </View>
      </ListSection>,
    );

  const mailbox =
    connection === null
      ? COPY.goneMailbox
      : (connection.connection.accountLabel ?? connection.connection.label);
  const view = kinMailRulePageView(rule, { leads, mailbox, now });
  const active = leads.filter((lead) => lead.retired === undefined);
  const mustChoose = view.state.needsLead;
  const lead = mustChoose
    ? (active.find((one) => one.agentId === chosen) ?? null)
    : (active.find((one) => one.agentId === rule.agentId) ?? null);

  const settle = async (
    key: string,
    failed: string,
    send: () => Promise<{ readonly ok: true } | { readonly ok: false; readonly problem: string }>,
  ) => {
    if (busy !== null) return;
    setBusy(key);
    setProblem(null);
    const outcome = await send();
    setBusy(null);
    reload();
    reloadAll();
    if (!outcome.ok) setProblem(outcome.problem || failed);
    return outcome.ok;
  };
  const pause = () =>
    void settle("pause", COPY.pauseFailed, () =>
      kinListSend({
        online,
        send: () => pauseCommand({ environmentId, input: { orgId, ruleId } }),
      }),
    );
  const resume = () => {
    if (lead === null) return;
    const agentId = lead.agentId as KinAgentId;
    Dialog.confirm({
      title: COPY.resumeTitle,
      message: COPY.resumeDetail(lead.name),
      confirmText: COPY.resume,
      onConfirm: () =>
        void settle("resume", COPY.resumeFailed, () =>
          kinMailRuleResumeSend({
            rule,
            agentId,
            newId: uuidv4,
            online,
            openChat: (input) => openChat({ environmentId, input }),
            resume: (input) => resumeCommand({ environmentId, input }),
          }),
        ),
    });
  };
  const remove = () =>
    Dialog.confirm({
      title: COPY.removeTitle,
      message: COPY.removeDetail,
      confirmText: COPY.removeConfirm,
      destructive: true,
      onConfirm: () =>
        void settle("remove", COPY.removeFailed, () =>
          kinListSend({
            online,
            send: () => removeCommand({ environmentId, input: { orgId, ruleId } }),
          }),
        ).then((ok) => {
          if (ok === true) navigation.goBack();
        }),
    });
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

  return frame(
    <>
      {view.state.detail === null ? null : (
        <ListSection>
          <View accessible className="bg-grouped-card">
            <ListRowLayout label={view.state.label} description={view.state.detail} />
          </View>
        </ListSection>
      )}
      {problem === null ? null : <ErrorBanner message={problem} />}

      <ListSection title={COPY.matchesTitle}>
        {view.facts.map((fact) => (
          <View key={fact.label} accessible className="bg-grouped-card">
            <ListRowLayout label={breakable(fact.value)} description={fact.label} />
          </View>
        ))}
      </ListSection>

      <ListSection title={COPY.pageWhat}>
        <View accessible className="bg-grouped-card px-4 py-3">
          <Text textRole="body" className="text-foreground">
            {breakable(view.what)}
          </Text>
        </View>
      </ListSection>

      {actions.runNow ? (
        <ListSection
          title={COPY.runNowTitle}
          footer={
            ran._tag === "done"
              ? ran.value
              : ran._tag === "failed"
                ? ran.text
                : COPY.runNowDescription
          }
        >
          <ListActionRow
            label={ran._tag === "busy" ? COPY.running : COPY.runNow}
            loading={ran._tag === "busy"}
            onPress={() => void runNow()}
          />
        </ListSection>
      ) : null}

      {actions.preview ? (
        <ListSection
          title={COPY.previewTitle}
          footer={
            preview._tag === "failed"
              ? preview.text
              : preview._tag === "done"
                ? (preview.value.note ?? COPY.previewDescription)
                : COPY.previewDescription
          }
        >
          {preview._tag === "done" ? (
            preview.value.empty === null ? (
              <LineRows rows={preview.value.rows} />
            ) : (
              <View className="bg-grouped-card">
                <ListRowLayout label={preview.value.empty} />
              </View>
            )
          ) : null}
          <ListActionRow
            label={preview._tag === "busy" ? COPY.previewing : COPY.preview}
            loading={preview._tag === "busy"}
            onPress={() => void runPreview()}
          />
        </ListSection>
      ) : null}

      {actions.history ? (
        <ListSection title={COPY.historyTitle}>
          {history._tag === "Initial" ? (
            <KinWorkLoading label={COPY.loading} />
          ) : history._tag === "Failure" ? (
            <ListActionRow
              label={kinFailureText(history.cause, COPY.historyFailed)}
              tone="danger"
              onPress={reloadHistory}
            />
          ) : runs.length === 0 ? (
            <View className="bg-grouped-card">
              <ListRowLayout label={COPY.historyEmpty} />
            </View>
          ) : (
            <>
              <LineRows rows={shownRuns} />
              {shownRuns.length < runs.length ? (
                <ListActionRow
                  label={COPY.historyShowAll(runs.length)}
                  onPress={() => setAllRuns(true)}
                />
              ) : null}
            </>
          )}
        </ListSection>
      ) : null}

      {actions.resume && mustChoose ? (
        <ListSection
          title={COPY.leadLabel}
          footer={active.length === 0 ? COPY.resumeNoLeads : COPY.resumeChoose}
        >
          {active.map((one) => (
            <ListChoiceRow
              key={one.agentId}
              label={one.name}
              selected={chosen === one.agentId}
              onPress={() => setChosen(one.agentId as KinAgentId)}
            />
          ))}
        </ListSection>
      ) : null}

      {actions.pause || actions.resume || actions.remove ? (
        <ListSection title={COPY.actionsTitle}>
          {actions.pause ? (
            <ListActionRow
              label={COPY.pause}
              description={COPY.pauseRow}
              loading={busy === "pause"}
              disabled={busy !== null}
              onPress={pause}
            />
          ) : null}
          {actions.resume ? (
            <ListActionRow
              label={COPY.resume}
              description={COPY.resumeRow}
              loading={busy === "resume"}
              disabled={busy !== null || lead === null}
              onPress={resume}
            />
          ) : null}
          {actions.remove ? (
            <ListActionRow
              tone="danger"
              label={COPY.remove}
              loading={busy === "remove"}
              disabled={busy !== null}
              onPress={remove}
            />
          ) : null}
        </ListSection>
      ) : null}
    </>,
  );
}
