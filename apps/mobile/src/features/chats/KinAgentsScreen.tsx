import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, KinOrgId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppBar } from "../../components/ui/AppBar";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListRow } from "../../components/ui/ListRow";
import { ListSection } from "../../components/ui/ListSection";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { appAtomRegistry } from "../../state/atom-registry";
import { kinClient } from "./state/kinClient";

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
  const atom = kinClient.leads({ environmentId, input: { orgId } });
  const result = useAtomValue(atom);
  const canAdd = useAtomValue(kinClient.leadCreate.permissionAtom(environmentId));
  const agents = Option.getOrNull(AsyncResult.value(result))?.leads ?? null;
  const add = canAdd
    ? () => navigation.navigate("KinLeadForm", { environmentId, orgId })
    : undefined;
  return (
    <KinAgentsFrame onAdd={add}>
      {agents === null ? (
        AsyncResult.isFailure(result) ? (
          <EmptyState
            variant="plain"
            title="Couldn't load your agents"
            detail="Check that this phone can reach your Kin, then try again."
            action={
              <Button
                tone="secondary"
                label="Try again"
                onPress={() => appAtomRegistry.refresh(atom)}
              />
            }
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
      ) : agents.length === 0 ? (
        <EmptyState
          variant="plain"
          title="No agents yet"
          detail="An agent looks after one part of the company, such as engineering or finance, and you talk to it in a chat."
          {...(add === undefined ? {} : { actionLabel: "New agent", onAction: add })}
        />
      ) : (
        <ListSection footer="Open an agent to see what it's doing, change what it's for, or choose who can message it.">
          {agents.map((agent) => (
            <ListRow
              key={agent.agentId}
              icon="sparkles"
              label={agent.name}
              description={agent.domain}
              {...(agent.working ? { detail: "Working" } : {})}
              onPress={() =>
                navigation.navigate("KinLead", { environmentId, orgId, agentId: agent.agentId })
              }
            />
          ))}
        </ListSection>
      )}
    </KinAgentsFrame>
  );
}
