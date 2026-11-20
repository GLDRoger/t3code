import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import {
  KIN_AGENT_PAGE,
  kinAgentModelLine,
  kinAgentQuietLine,
  kinAgentRewriteStarter,
  kinAgentUsageLine,
} from "@t3tools/client-runtime/kin/kinAgentPage";
import { kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import { kinDocMarkdown } from "@t3tools/client-runtime/kin/kinChatFeed";
import { kinCheckInLine } from "@t3tools/client-runtime/kin/kinCheckIns";
import {
  kinLeadModelName,
  kinProviderLimitLine,
} from "@t3tools/client-runtime/kin/kinLeadPresentation";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  KinAgentPage,
  KinLeadProfile,
  KinOrgId,
  ModelSelection,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRow } from "../../components/ui/ListRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { appAtomRegistry } from "../../state/atom-registry";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { setComposerDraftText } from "../../state/use-composer-drafts";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import { kinDraftKey } from "./components/KinComposer";
import { KinLoadFailed } from "./components/KinLoadFailed";
import {
  KinAgentEffortAdvice,
  KinAgentEffortRow,
  KinAgentModelRow,
  kinPickedModel,
  useKinAgentModelOptions,
} from "./KinAgentModelRow";
import { KinAgentChanged } from "./KinAgentChanged";
import { kinClient, refreshKinAgents } from "./state/kinClient";

const row = (index: number) => (index === 0 ? undefined : "border-t border-border-subtle");

/**
 * What owner-level people see and change about one agent beyond what it is for: its model, its
 * character, when it speaks, what it reaches, and pausing it. Read from the host's page.
 */
export function KinAgentSections(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly lead: KinLeadProfile;
}) {
  const { environmentId, orgId, lead } = props;
  const pageAtom = kinClient.agentPage({
    environmentId,
    input: { orgId, agentId: lead.agentId },
  });
  const result = useAtomValue(pageAtom);
  // What was last read stays up while a change is read again.
  const page = Option.getOrNull(AsyncResult.value(result));
  if (page === null)
    return AsyncResult.isFailure(result) ? (
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
    );
  const changed = () => {
    appAtomRegistry.refresh(pageAtom);
    refreshKinAgents(environmentId, orgId);
  };
  return (
    <>
      <Models environmentId={environmentId} orgId={orgId} page={page} onChanged={changed} />
      <Character environmentId={environmentId} orgId={orgId} page={page} />
      <CheckIns environmentId={environmentId} orgId={orgId} page={page} />
      <ListSection title={KIN_AGENT_PAGE.teamAgent}>
        <View className="px-4 py-3">
          <Text textRole="body" className="text-foreground">
            {page.teamAgent ? KIN_AGENT_PAGE.teamAgentDetail : KIN_AGENT_PAGE.notTeamAgent}
          </Text>
        </View>
      </ListSection>
      <Reach environmentId={environmentId} orgId={orgId} page={page} />
      {page.changed === undefined ? null : (
        <KinAgentChanged
          environmentId={environmentId}
          orgId={orgId}
          agentId={lead.agentId}
          changed={page.changed}
          onChanged={changed}
        />
      )}
      <Pause environmentId={environmentId} orgId={orgId} page={page} onChanged={changed} />
    </>
  );
}

function Models(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly page: KinAgentPage;
  readonly onChanged: () => void;
}) {
  const { environmentId, orgId, page } = props;
  const options = useKinAgentModelOptions(environmentId);
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const canEdit =
    useAtomValue(kinClient.leadUpdate.permissionAtom(environmentId)) &&
    page.profile.retired === undefined;
  const update = useAtomCommand(kinClient.leadUpdate, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const choose = async (model: ModelSelection) => {
    setBusy(true);
    const outcome = await update({
      environmentId,
      input: { orgId, agentId: page.profile.agentId, model },
    });
    setBusy(false);
    setProblem(
      AsyncResult.isFailure(outcome)
        ? kinFailureText(squashAtomCommandFailure(outcome), KIN_AGENT_PAGE.modelFailed)
        : null,
    );
    props.onChanged();
  };
  const limit = kinProviderLimitLine(
    providers?.find((provider) => provider.instanceId === page.runsOn.instanceId)?.driver,
  );
  const name = (selection: ModelSelection) =>
    kinAgentModelLine(kinLeadModelName(selection.model, providers), selection);
  return (
    <View className="gap-2">
      <ListSection title={KIN_AGENT_PAGE.model}>
        {canEdit ? (
          <>
            <KinAgentModelRow
              label={KIN_AGENT_PAGE.model}
              value={page.model}
              valueName={kinLeadModelName(page.model.model, providers)}
              options={options}
              disabled={busy}
              onPick={(selection) =>
                void choose(
                  // The same model keeps the effort it has; a new one starts at Medium.
                  selection.model === page.model.model &&
                    selection.instanceId === page.model.instanceId
                    ? page.model
                    : kinPickedModel(options, selection),
                )
              }
            />
            <KinAgentEffortRow
              label={KIN_AGENT_PAGE.effort}
              value={page.model}
              options={options}
              disabled={busy}
              onPick={(selection) => void choose(selection)}
            />
          </>
        ) : (
          <View className={row(0)}>
            <ListRowLayout label={KIN_AGENT_PAGE.model} detail={name(page.model)} />
          </View>
        )}
      </ListSection>
      {canEdit ? <KinAgentEffortAdvice value={page.model} options={options} /> : null}
      <Text
        textRole="footnote"
        accessibilityLiveRegion={problem === null && page.modelNote === null ? "none" : "polite"}
        className={
          problem === null && page.modelNote === null
            ? "px-4 text-foreground-muted"
            : "px-4 text-danger-foreground"
        }
      >
        {problem ??
          (page.modelNote === null
            ? [KIN_AGENT_PAGE.modelDetail, limit, kinAgentUsageLine(page.usedThisMonth)]
                .filter(Boolean)
                .join(" ")
            : `${page.modelNote} Now: ${name(page.runsOn)}.`)}
      </Text>
    </View>
  );
}

function Character(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly page: KinAgentPage;
}) {
  const { environmentId, orgId, page } = props;
  const navigation = useNavigation();
  const styles = useMarkdownPreviewStyles();
  const canSave = useAtomValue(kinClient.characterSet.permissionAtom(environmentId));
  const live = page.profile.retired === undefined;
  const { character } = page;
  return (
    <ListSection title={KIN_AGENT_PAGE.character} footer={KIN_AGENT_PAGE.characterRule}>
      {character === null ? (
        <View className="px-4 py-3">
          <Text textRole="body" className="text-foreground-muted">
            {KIN_AGENT_PAGE.characterEmpty}
          </Text>
        </View>
      ) : (
        <>
          <View className="max-h-96 overflow-hidden px-4 py-3">
            <SelectableMarkdownText
              markdown={kinDocMarkdown(character.body)}
              textStyle={styles.nativeTextStyle}
              selectable={false}
            />
          </View>
          {canSave && live ? (
            <View className="border-t border-border-subtle">
              <ListActionRow
                label="Edit character"
                icon="pencil"
                onPress={() =>
                  navigation.navigate("KinAgentCharacter", {
                    environmentId,
                    orgId,
                    agentId: page.profile.agentId,
                  })
                }
              />
            </View>
          ) : null}
          <View className="border-t border-border-subtle">
            <ListActionRow
              label="History and restore"
              icon="clock"
              onPress={() =>
                navigation.navigate("KinDocHistory", { environmentId, orgId, doc: character.key })
              }
            />
          </View>
        </>
      )}
      {live ? (
        <View className="border-t border-border-subtle">
          <ListActionRow
            label={KIN_AGENT_PAGE.rewrite}
            icon="text.bubble"
            onPress={() => {
              const chatId = page.profile.ownerChatId;
              setComposerDraftText(
                kinDraftKey(environmentId, orgId, chatId),
                kinAgentRewriteStarter(page.profile.name),
              );
              navigation.navigate("KinChat", { environmentId, orgId, chatId });
            }}
          />
        </View>
      ) : null}
    </ListSection>
  );
}

function CheckIns(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly page: KinAgentPage;
}) {
  const { environmentId, orgId, page } = props;
  const result = useAtomValue(kinClient.checkIns({ environmentId, input: { orgId } }));
  const checkIns = (Option.getOrNull(AsyncResult.value(result))?.checkIns ?? []).filter(
    (checkIn) => checkIn.agentId === page.profile.agentId,
  );
  return (
    <ListSection title={KIN_AGENT_PAGE.checkIns} footer={kinAgentQuietLine(page.quietHours)}>
      {checkIns.length === 0 ? (
        <View className="px-4 py-3">
          <Text textRole="body" className="text-foreground-muted">
            {KIN_AGENT_PAGE.checkInsNone}
          </Text>
        </View>
      ) : (
        checkIns.map((checkIn, index) => (
          <View key={checkIn.scheduleId} className={row(index)}>
            <ListRowLayout
              label={`${checkIn.title}${checkIn.on ? "" : " (off)"}`}
              description={kinCheckInLine(checkIn).replace(` · ${checkIn.agentName}`, "")}
            />
          </View>
        ))
      )}
    </ListSection>
  );
}

function Reach(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly page: KinAgentPage;
}) {
  const { environmentId, orgId, page } = props;
  const navigation = useNavigation();
  return (
    <>
      <ListSection title={KIN_AGENT_PAGE.reach} footer={KIN_AGENT_PAGE.reachDetail}>
        {page.connections.length === 0 ? (
          <View className="px-4 py-3">
            <Text textRole="body" className="text-foreground-muted">
              {KIN_AGENT_PAGE.reachNone}
            </Text>
          </View>
        ) : (
          page.connections.map((connection, index) => (
            // Labels can repeat and carry no id here; the host's order is stable.
            // oxlint-disable-next-line react/no-array-index-key
            <View key={index} className={row(index)}>
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
      </ListSection>
      <ListSection title={KIN_AGENT_PAGE.playbooks}>
        {page.playbooks.length === 0 ? (
          <View className="px-4 py-3">
            <Text textRole="body" className="text-foreground-muted">
              {KIN_AGENT_PAGE.playbooksNone}
            </Text>
          </View>
        ) : (
          page.playbooks.map((playbook, index) => (
            <View key={playbook.key} className={row(index)}>
              <ListRow
                label={playbook.title}
                onPress={() =>
                  navigation.navigate("KinDoc", { environmentId, orgId, doc: playbook.key })
                }
              />
            </View>
          ))
        )}
      </ListSection>
    </>
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
                ? kinFailureText(squashAtomCommandFailure(outcome), "Couldn't change that.")
                : null,
            );
            props.onChanged();
          });
        }}
      />
    </ListSection>
  );
}
