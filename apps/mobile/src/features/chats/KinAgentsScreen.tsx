import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  KIN_RESTORE_ACTION,
  KIN_RETIRED_LABEL,
  kinAgentGroups,
} from "@t3tools/client-runtime/kin/kinAgentRetire";
import { kinDomainLabel, KIN_AGENTS_COPY } from "@t3tools/client-runtime/kin/kinLeadPresentation";
import { KIN_DAILY_LIMIT, kinDailyLimitWaiting } from "@t3tools/client-runtime/kin/kinBudget";
import { kinCount } from "@t3tools/client-runtime/kin/kinCount";
import { KIN_SET_UP_ON_COMPUTER } from "@t3tools/client-runtime/kin/kinNavigation";
import {
  KIN_TEAM_AGENT_COPY,
  kinTeamAgentChoices,
  kinTeamAgentLabel,
} from "@t3tools/client-runtime/kin/kinProfiles";
import { kinTeamAgentDetail } from "@t3tools/client-runtime/kin/kinReach";
import { EnvironmentId, KinOrgId } from "@t3tools/contracts";
import { kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import { View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { KinLoadFailed } from "./components/KinLoadFailed";
import { KinFoldSection } from "./components/KinWorkPieces";
import { ListRow } from "../../components/ui/ListRow";
import { ListSection } from "../../components/ui/ListSection";
import { Menu } from "../../components/ui/Menu";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { appAtomRegistry } from "../../state/atom-registry";
import { SettingsRow } from "../settings/components/SettingsRow";
import { SettingsSection } from "../settings/components/SettingsSection";
import { kinClient } from "./state/kinClient";
import { useKinWorkingAgents } from "./state/useKinInbox";
import { useAtomCommand } from "../../state/use-atom-command";
import { kinRetiredWhenNow, useKinAgentRetire } from "./state/useKinAgentRetire";

const noBudgetAtom = Atom.make(AsyncResult.initial<never, never>());

export type KinAgentsParams = { readonly environmentId: string; readonly orgId: string };

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeOrgId = Schema.decodeUnknownOption(KinOrgId);

/** Every agent the owner has made: what each is for, a way to open one, and a way to add another. */
export function KinAgentsScreen({ route }: StaticScreenProps<KinAgentsParams>) {
  const environmentId = Option.getOrNull(decodeEnvironmentId(route.params.environmentId));
  const orgId = Option.getOrNull(decodeOrgId(route.params.orgId));
  if (environmentId === null || orgId === null) {
    return (
      <KinAgentsFrame>
        <EmptyState
          variant="plain"
          title="This link doesn't open anything"
          detail="Open Agents from Settings."
        />
      </KinAgentsFrame>
    );
  }
  return <KinAgentsBody environmentId={environmentId} orgId={orgId} />;
}

function KinAgentsFrame(props: {
  readonly onAdd?: (() => void) | undefined;
  readonly children: React.ReactNode;
}) {
  const navigation = useNavigation();
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar
        title="Agents"
        onBack={() => navigation.goBack()}
        {...(props.onAdd === undefined
          ? {}
          : { actions: [{ accessibilityLabel: "New agent", icon: "plus", onPress: props.onAdd }] })}
      />
      <ScreenContent surface="screen">
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 20 }}
        >
          {props.children}
        </ScreenScrollView>
      </ScreenContent>
    </View>
  );
}

function KinAgentsBody(props: { readonly environmentId: EnvironmentId; readonly orgId: KinOrgId }) {
  const navigation = useNavigation();
  const { environmentId, orgId } = props;
  // Only a session that may restore an agent asks the host for the retired ones.
  const canRestore = useAtomValue(kinClient.leadRestore.permissionAtom(environmentId));
  const working = useKinWorkingAgents(environmentId);
  const atom = canRestore
    ? kinClient.agents({ environmentId, orgId })
    : kinClient.leads({ environmentId, input: { orgId } });
  const result = useAtomValue(atom);
  const canAdd = useAtomValue(kinClient.leadCreate.permissionAtom(environmentId));
  const retire = useKinAgentRetire(environmentId);
  // Work the daily limit holds shows on its agent's row; the limit itself is set on the computer.
  const budget = useAtomValue(
    canAdd ? kinClient.budget({ environmentId, input: { orgId } }) : noBudgetAtom,
  );
  const held = new Map(
    kinDailyLimitWaiting(Option.getOrNull(AsyncResult.value(budget))).map((agent) => [
      agent.agentId,
      agent.line,
    ]),
  );
  // What was last read stays up while a change is read again.
  const all = Option.getOrNull(AsyncResult.value(result))?.leads ?? null;
  const groups = all === null ? null : kinAgentGroups(all);
  const agents = groups?.active ?? null;
  const retired = groups?.retired ?? [];
  const add = canAdd
    ? () => navigation.navigate("KinLeadForm", { environmentId, orgId })
    : undefined;
  return (
    <KinAgentsFrame onAdd={add}>
      {canAdd ? <KinTeamAgentRow environmentId={environmentId} orgId={orgId} /> : null}
      {agents === null ? (
        AsyncResult.isFailure(result) ? (
          <KinLoadFailed
            title={KIN_AGENTS_COPY.loadFailedTitle}
            cause={result}
            onRetry={() => appAtomRegistry.refresh(atom)}
          />
        ) : (
          <View
            className="items-center py-12"
            accessible
            accessibilityRole="progressbar"
            accessibilityLabel="Loading agents"
          >
            <AppActivityIndicator />
          </View>
        )
      ) : agents.length === 0 && retired.length === 0 ? (
        <EmptyState
          variant="plain"
          title={KIN_AGENTS_COPY.noneTitle}
          detail={KIN_AGENTS_COPY.explain}
          {...(add === undefined ? {} : { actionLabel: "New agent", onAction: add })}
        />
      ) : (
        <ListSection footer="Open an agent to see what it's doing, change what it's for, or choose who can message it.">
          {agents.map((agent) => (
            <ListRow
              key={agent.agentId}
              icon="robot"
              label={agent.name}
              description={[kinDomainLabel(agent.domain), held.get(agent.agentId) ?? null]
                .filter((line) => line !== null)
                .join("\n")}
              {...(agent.paused !== undefined
                ? { detail: "Paused" }
                : held.has(agent.agentId)
                  ? { detail: KIN_DAILY_LIMIT.waiting }
                  : working.has(agent.agentId)
                    ? { detail: "Working" }
                    : {})}
              onPress={() =>
                navigation.navigate("KinLead", { environmentId, orgId, agentId: agent.agentId })
              }
            />
          ))}
        </ListSection>
      )}
      {retired.length === 0 ? null : (
        <KinFoldSection
          title={KIN_RETIRED_LABEL}
          summary={kinCount(retired.length, "agent", "agents")}
        >
          {retired.map((agent) => (
            <ListRow
              key={agent.agentId}
              icon="robot"
              label={agent.name}
              description={kinRetiredWhenNow(agent.retired?.at)}
              detail={retire.busy === agent.agentId ? "Restoring…" : KIN_RESTORE_ACTION}
              disabled={retire.busy !== null}
              onPress={() => retire.restore(agent)}
            />
          ))}
          <Text textRole="footnote" className="px-4 py-3 text-foreground-muted">
            A retired agent's chats, tasks and what it remembers are kept. Restoring it starts its
            reminders and scheduled tasks again.
          </Text>
        </KinFoldSection>
      )}
      {canAdd && agents !== null && agents.length > 0 ? (
        <Text textRole="footnote" className="px-4 text-foreground-muted">
          {KIN_SET_UP_ON_COMPUTER.agents}
        </Text>
      ) : null}
    </KinAgentsFrame>
  );
}

/** Which agent every teammate can chat with, or Off: the first choice on the Agents page. */
function KinTeamAgentRow(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
}) {
  const leadsAtom = kinClient.leads({
    environmentId: props.environmentId,
    input: { orgId: props.orgId },
  });
  const result = useAtomValue(leadsAtom);
  const refresh = useAtomRefresh(leadsAtom);
  const canSet = useAtomValue(kinClient.teamAgentSet.permissionAtom(props.environmentId));
  const set = useAtomCommand(kinClient.teamAgentSet, { reportFailure: false });
  const list = Option.getOrNull(AsyncResult.value(result));
  const reach = useAtomValue(
    kinClient.reach({ environmentId: props.environmentId, input: { orgId: props.orgId } }),
  );
  const leads = list?.leads ?? [];
  const current = list?.teamAgentId ?? null;
  const choices = kinTeamAgentChoices(leads);
  return (
    <SettingsSection
      footer={kinTeamAgentDetail(Option.getOrNull(AsyncResult.value(reach)), current)}
    >
      <Menu
        actions={choices.map((choice) => ({
          id: choice.agentId ?? "off",
          title: choice.label,
          ...(choice.suggested ? { subtitle: KIN_TEAM_AGENT_COPY.suggested } : {}),
          state: choice.agentId === current ? ("on" as const) : ("off" as const),
        }))}
        onPressAction={({ nativeEvent }) => {
          const picked = choices.find((choice) => (choice.agentId ?? "off") === nativeEvent.event);
          if (picked === undefined || picked.agentId === current) return;
          void set({
            environmentId: props.environmentId,
            input: { orgId: props.orgId, agentId: picked.agentId },
          }).then((outcome) => {
            if (AsyncResult.isFailure(outcome))
              Dialog.alert(
                kinFailureText(squashAtomCommandFailure(outcome), KIN_TEAM_AGENT_COPY.failed),
              );
            refresh();
          });
        }}
      >
        <SettingsRow
          icon="bubble.left.and.bubble.right"
          label={KIN_TEAM_AGENT_COPY.label}
          value={list === null ? "…" : kinTeamAgentLabel(leads, current)}
          valuePosition="trailing"
          disabled={!canSet || list === null}
        />
      </Menu>
    </SettingsSection>
  );
}
