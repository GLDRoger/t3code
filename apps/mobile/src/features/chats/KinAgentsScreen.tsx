import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  KIN_RESTORE_ACTION,
  KIN_RETIRED_LABEL,
  kinAgentGroups,
} from "@t3tools/client-runtime/kin/kinAgentRetire";
import {
  KIN_OTHER_PROVIDER_AGENTS,
  kinDomainLabel,
  KIN_AGENTS_COPY,
} from "@t3tools/client-runtime/kin/kinLeadPresentation";
import { EnvironmentId, KinOrgId, type ModelSelection } from "@t3tools/contracts";
import { KIN_AGENT_PAGE } from "@t3tools/client-runtime/kin/kinAgentPage";
import { kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppBar } from "../../components/ui/AppBar";
import { EmptyState } from "../../components/ui/EmptyState";
import { KinLoadFailed } from "./components/KinLoadFailed";
import { ListRow } from "../../components/ui/ListRow";
import { ListSection } from "../../components/ui/ListSection";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { appAtomRegistry } from "../../state/atom-registry";
import { useEnvironmentServerConfig } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { kinClient } from "./state/kinClient";
import { useKinWorkingAgents } from "./state/useKinInbox";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  KinAgentEffortAdvice,
  KinAgentEffortRow,
  KinAgentModelRow,
  kinPickedModel,
  useKinAgentModelOptions,
} from "./KinAgentModelRow";
import { kinRetiredWhenNow, useKinAgentRetire } from "./state/useKinAgentRetire";

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
              description={kinDomainLabel(agent.domain)}
              {...(agent.paused !== undefined
                ? { detail: "Paused" }
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
      {canAdd && agents !== null && agents.length > 0 ? (
        <>
          <KinAgentDefaults environmentId={environmentId} orgId={orgId} />
          <KinOtherProviderAgents environmentId={environmentId} />
        </>
      ) : null}
      {retired.length === 0 ? null : (
        <ListSection
          title={KIN_RETIRED_LABEL}
          footer="A retired agent's chats, tasks and what it remembers are kept. Restoring it starts its reminders and scheduled tasks again."
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
        </ListSection>
      )}
    </KinAgentsFrame>
  );
}

/** The host's experimental switch that lets agents run on providers behind it. */
function KinOtherProviderAgents(props: { readonly environmentId: EnvironmentId }) {
  const config = useEnvironmentServerConfig(props.environmentId);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: KIN_OTHER_PROVIDER_AGENTS.title,
    reportFailure: true,
  });
  if (config === null) return null;
  return (
    <ListSection footer={KIN_OTHER_PROVIDER_AGENTS.detail}>
      <ListToggleRow
        label={KIN_OTHER_PROVIDER_AGENTS.title}
        value={config.settings.kinNonClaudeAgents}
        onValueChange={(on) =>
          void updateSettings({
            environmentId: props.environmentId,
            input: { patch: { kinNonClaudeAgents: on } },
          })
        }
      />
    </ListSection>
  );
}

/** The model new agents start on; each agent's own is on its page. */
function KinAgentDefaults(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
}) {
  const { environmentId, orgId } = props;
  const defaultsAtom = kinClient.agentDefaults({ environmentId, input: { orgId } });
  const defaults = Option.getOrNull(AsyncResult.value(useAtomValue(defaultsAtom)));
  const options = useKinAgentModelOptions(environmentId);
  const save = useAtomCommand(kinClient.agentDefaultsSet, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const base = defaults?.model ?? null;
  if (base === null) return null;
  const choose = (model: ModelSelection) => {
    setBusy(true);
    void save({ environmentId, input: { orgId, model } }).then((outcome) => {
      setBusy(false);
      setProblem(
        AsyncResult.isFailure(outcome)
          ? kinFailureText(squashAtomCommandFailure(outcome), KIN_AGENTS_COPY.saveFailed)
          : null,
      );
      appAtomRegistry.refresh(defaultsAtom);
    });
  };
  return (
    <View className="gap-2">
      <ListSection
        title={KIN_AGENT_PAGE.defaults}
        footer={
          problem ??
          `${KIN_AGENT_PAGE.defaultsDetail}${defaults?.chosen === false ? ` ${KIN_AGENT_PAGE.defaultsUnchosen}` : ""}`
        }
      >
        <KinAgentModelRow
          label={KIN_AGENT_PAGE.model}
          value={base}
          options={options}
          disabled={busy}
          onPick={(selection) => choose(kinPickedModel(options, selection))}
        />
        <KinAgentEffortRow
          label={KIN_AGENT_PAGE.effort}
          value={base}
          options={options}
          disabled={busy}
          onPick={choose}
        />
      </ListSection>
      <KinAgentEffortAdvice value={base} options={options} />
    </View>
  );
}
