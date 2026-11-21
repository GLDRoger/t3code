import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import {
  KIN_AGENT_PAGE,
  kinAgentPageFolds,
  kinAgentQuietLine,
} from "@t3tools/client-runtime/kin/kinAgentPage";
import { kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import { kinCheckInLine } from "@t3tools/client-runtime/kin/kinCheckIns";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  KinAgentPage,
  KinCheckIn,
  KinLeadProfile,
  KinOrgId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useState, type ReactNode } from "react";
import { View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRow } from "../../components/ui/ListRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { appAtomRegistry } from "../../state/atom-registry";
import { useAtomCommand } from "../../state/use-atom-command";
import { KinFoldSection } from "./components/KinWorkPieces";
import { KinLoadFailed } from "./components/KinLoadFailed";
import { KinAgentChanged } from "./KinAgentChanged";
import { kinClient, refreshKinAgents } from "./state/kinClient";

// Each fold's rows sit under its title row.
const ROW = "border-t border-border-subtle";

/**
 * What owner-level people see and change about one agent below what it is for: pausing it, its
 * mute, then folded its check-ins, what it reaches, its playbooks and its last changes. Read from
 * the host's page; character, model and effort are changed on the computer.
 */
export function KinAgentSections(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly lead: KinLeadProfile;
  /** The viewer's mute for its chat, under Pause. */
  readonly mute?: ReactNode;
}) {
  const { environmentId, orgId, lead } = props;
  const pageAtom = kinClient.agentPage({
    environmentId,
    input: { orgId, agentId: lead.agentId },
  });
  const result = useAtomValue(pageAtom);
  const checkInsRead = useAtomValue(kinClient.checkIns({ environmentId, input: { orgId } }));
  // What was last read stays up while a change is read again.
  const page = Option.getOrNull(AsyncResult.value(result));
  if (page === null)
    return (
      <>
        {props.mute}
        {AsyncResult.isFailure(result) ? (
          <KinLoadFailed
            variant="card"
            title={KIN_AGENT_PAGE.loadFailed}
            cause={result}
            onRetry={() => appAtomRegistry.refresh(pageAtom)}
          />
        ) : (
          <View
            className="items-center py-8"
            accessible
            accessibilityRole="progressbar"
            accessibilityLabel="Loading this agent"
          >
            <AppActivityIndicator />
          </View>
        )}
      </>
    );
  const changed = () => {
    appAtomRegistry.refresh(pageAtom);
    refreshKinAgents(environmentId, orgId);
  };
  const heldCheckIns = Option.getOrNull(AsyncResult.value(checkInsRead));
  const checkIns =
    heldCheckIns?.checkIns.filter((checkIn) => checkIn.agentId === lead.agentId) ?? null;
  return (
    <>
      <Pause environmentId={environmentId} orgId={orgId} page={page} onChanged={changed} />
      {props.mute}
      {kinAgentPageFolds(page, checkIns?.length ?? null).map((fold) => (
        <KinFoldSection key={fold.id} title={fold.title} summary={fold.summary}>
          {fold.id === "checkIns" ? (
            <CheckIns
              environmentId={environmentId}
              orgId={orgId}
              page={page}
              checkIns={checkIns ?? []}
            />
          ) : fold.id === "reach" ? (
            <Reach page={page} />
          ) : fold.id === "playbooks" ? (
            <Playbooks environmentId={environmentId} orgId={orgId} page={page} />
          ) : page.changed === undefined ? null : (
            <KinAgentChanged
              environmentId={environmentId}
              orgId={orgId}
              agentId={lead.agentId}
              changed={page.changed}
              onChanged={changed}
            />
          )}
        </KinFoldSection>
      ))}
      <ListSection title={KIN_AGENT_PAGE.teamAgent}>
        <View className="px-4 py-3">
          <Text textRole="body" className="text-foreground">
            {page.teamAgent ? KIN_AGENT_PAGE.teamAgentDetail : KIN_AGENT_PAGE.notTeamAgent}
          </Text>
        </View>
      </ListSection>
    </>
  );
}

function Note(props: { readonly text: string }) {
  return (
    <View className={`${ROW} px-4 py-3`}>
      <Text textRole="footnote" className="text-foreground-muted">
        {props.text}
      </Text>
    </View>
  );
}

function Empty(props: { readonly text: string }) {
  return (
    <View className={`${ROW} px-4 py-3`}>
      <Text textRole="body" className="text-foreground-muted">
        {props.text}
      </Text>
    </View>
  );
}

function CheckIns(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly page: KinAgentPage;
  readonly checkIns: ReadonlyArray<KinCheckIn>;
}) {
  const { environmentId, orgId, page } = props;
  const navigation = useNavigation();
  return (
    <>
      {props.checkIns.length === 0 ? (
        <Empty text={KIN_AGENT_PAGE.checkInsNone} />
      ) : (
        props.checkIns.map((checkIn) => (
          <View key={checkIn.scheduleId} className={ROW}>
            <ListRow
              label={`${checkIn.title}${checkIn.on ? "" : " (off)"}`}
              description={kinCheckInLine(checkIn).replace(` · ${checkIn.agentName}`, "")}
              onPress={() =>
                navigation.navigate("KinCheckInForm", {
                  environmentId,
                  orgId,
                  checkIn: checkIn.scheduleId,
                })
              }
            />
          </View>
        ))
      )}
      <Note text={kinAgentQuietLine(page.quietHours)} />
    </>
  );
}

function Reach(props: { readonly page: KinAgentPage }) {
  const { page } = props;
  return (
    <>
      {page.connections.length === 0 ? (
        <Empty text={KIN_AGENT_PAGE.reachNone} />
      ) : (
        page.connections.map((connection, index) => (
          // Labels can repeat and carry no id here; the host's order is stable.
          // oxlint-disable-next-line react/no-array-index-key
          <View key={index} className={ROW}>
            <ListRowLayout
              label={connection.label}
              description={
                connection.account === connection.label
                  ? undefined
                  : (connection.account ?? undefined)
              }
              detail={connection.paused ? "Paused" : undefined}
            />
          </View>
        ))
      )}
      <Note text={KIN_AGENT_PAGE.reachDetail} />
    </>
  );
}

function Playbooks(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly page: KinAgentPage;
}) {
  const { environmentId, orgId, page } = props;
  const navigation = useNavigation();
  return page.playbooks.length === 0 ? (
    <Empty text={KIN_AGENT_PAGE.playbooksNone} />
  ) : (
    page.playbooks.map((playbook) => (
      <View key={playbook.key} className={ROW}>
        <ListRow
          label={playbook.title}
          onPress={() => navigation.navigate("KinDoc", { environmentId, orgId, doc: playbook.key })}
        />
      </View>
    ))
  );
}

function Pause(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly page: KinAgentPage;
  readonly onChanged: () => void;
}) {
  const { environmentId, orgId, page } = props;
  const lead = page.profile;
  const canPause = useAtomValue(kinClient.leadPause.permissionAtom(environmentId));
  const pause = useAtomCommand(kinClient.leadPause, { reportFailure: false });
  const resume = useAtomCommand(kinClient.leadResume, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (!canPause || lead.retired !== undefined) return null;
  const paused = lead.paused !== undefined;
  return (
    <ListSection
      footer={
        problem ?? (paused ? KIN_AGENT_PAGE.pausedLine(lead.name) : KIN_AGENT_PAGE.pauseDetail)
      }
    >
      <ListActionRow
        label={`${paused ? KIN_AGENT_PAGE.resume : KIN_AGENT_PAGE.pause} ${lead.name}`}
        icon={paused ? "play" : "pause"}
        loading={busy}
        onPress={() => {
          setBusy(true);
          void (paused ? resume : pause)({
            environmentId,
            input: { orgId, agentId: lead.agentId },
          }).then((outcome) => {
            setBusy(false);
            setProblem(
              AsyncResult.isFailure(outcome)
                ? kinFailureText(squashAtomCommandFailure(outcome), KIN_AGENT_PAGE.changeFailed)
                : null,
            );
            props.onChanged();
          });
        }}
      />
    </ListSection>
  );
}
