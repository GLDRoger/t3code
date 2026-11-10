import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, KinOrgId, type KinLeadProfile } from "@t3tools/contracts";
import {
  kinDomainLabel,
  kinLeadTrackingDetail,
} from "@t3tools/client-runtime/kin/kinLeadPresentation";
import { kinAgentAvatar } from "@t3tools/client-runtime/kin/kinScreenState";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { appAtomRegistry } from "../../state/atom-registry";
import { KinAvatar } from "./components/KinAvatar";
import { kinClient } from "./state/kinClient";

export type KinLeadParams = {
  readonly environmentId: string;
  readonly orgId: string;
  readonly agentId: string;
};

const kinSentenceParts = (parts: ReadonlyArray<string | null>) =>
  parts.filter((part) => part !== null).join(" · ") || null;

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeOrgId = Schema.decodeUnknownOption(KinOrgId);

/** A lead as its owner sees it: who it is, what it is for and what it has in hand. */
export function KinLeadScreen({ route }: StaticScreenProps<KinLeadParams>) {
  const navigation = useNavigation();
  const environmentId = Option.getOrNull(decodeEnvironmentId(route.params.environmentId));
  const orgId = Option.getOrNull(decodeOrgId(route.params.orgId));
  if (environmentId === null || orgId === null) {
    return (
      <View collapsable={false} className="flex-1 bg-screen">
        <AppBar title="Lead details" onClose={() => navigation.goBack()} />
        <ScreenContent surface="screen">
          <EmptyState
            variant="plain"
            title="This link doesn't name a lead"
            detail="Open a lead from its chat."
          />
        </ScreenContent>
      </View>
    );
  }
  return <KinLeadBody environmentId={environmentId} orgId={orgId} agentId={route.params.agentId} />;
}

function KinLeadBody(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly agentId: string;
}) {
  const navigation = useNavigation();
  const { environmentId, orgId, agentId } = props;
  const atom = kinClient.leads({ environmentId, input: { orgId } });
  const result = useAtomValue(atom);
  const canEdit = useAtomValue(kinClient.leadUpdate.permissionAtom(environmentId));
  const lead = AsyncResult.isSuccess(result)
    ? (result.value.leads.find((held) => held.agentId === agentId) ?? null)
    : null;
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar
        title="Lead details"
        onClose={() => navigation.goBack()}
        actions={
          lead === null || !canEdit
            ? undefined
            : [
                {
                  accessibilityLabel: `Edit ${lead.name}`,
                  icon: "pencil",
                  onPress: () =>
                    navigation.navigate("KinLeadForm", { environmentId, orgId, agentId }),
                },
              ]
        }
      />
      <ScreenContent surface="screen">
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 20 }}
        >
          {lead !== null ? (
            <KinLeadProfileView lead={lead} />
          ) : AsyncResult.isInitial(result) ? (
            <View
              className="items-center py-12"
              accessible
              accessibilityRole="progressbar"
              accessibilityLabel="Loading lead"
            >
              <AppActivityIndicator />
            </View>
          ) : AsyncResult.isFailure(result) ? (
            <EmptyState
              variant="plain"
              title="Couldn't load this lead"
              detail="Check your connection to the server and try again."
              action={
                <Button
                  tone="secondary"
                  label="Try again"
                  onPress={() => appAtomRegistry.refresh(atom)}
                />
              }
            />
          ) : (
            <EmptyState
              variant="plain"
              title="Not one of your leads"
              detail="Only the person who set up a lead can see its details."
            />
          )}
        </ScreenScrollView>
      </ScreenContent>
    </View>
  );
}

/** Also drawn from fixtures in the component catalog. */
export function KinLeadProfileView({ lead }: { readonly lead: KinLeadProfile }) {
  const charter = lead.charter.trim();
  const area = kinDomainLabel(lead.domain);
  // A lead named after its area would say the same word twice.
  const detail = kinSentenceParts([
    area.toLowerCase() === lead.name.trim().toLowerCase() ? null : area,
    lead.working ? "Working now" : null,
  ]);
  return (
    <>
      <View className="items-center gap-3 pt-2">
        <KinAvatar
          avatar={kinAgentAvatar(lead.agentId)}
          size="large"
          status={lead.working ? "working" : null}
        />
        <View className="items-center gap-1">
          <Text textRole="title" className="text-center font-t3-bold text-foreground">
            {lead.name}
          </Text>
          {detail === null ? null : (
            <Text textRole="footnote" className="text-center text-foreground-muted">
              {detail}
            </Text>
          )}
        </View>
      </View>
      <ListSection title="Responsible for">
        <View className="px-4 py-3">
          <Text
            textRole="body"
            selectable
            className={charter === "" ? "text-foreground-muted" : "text-foreground"}
          >
            {charter === ""
              ? "Nothing written yet. Add a few lines so it knows what to focus on."
              : charter}
          </Text>
        </View>
      </ListSection>
      <ListSection title="In hand" footer={`Thinks with ${lead.model}.`}>
        {lead.tracking.length === 0 ? (
          <View className="px-4 py-3">
            <Text textRole="body" className="text-foreground-muted">
              Nothing right now. Reminders, follow-ups and work it starts show up here.
            </Text>
          </View>
        ) : (
          lead.tracking.map((item, index) => (
            <View
              key={`${item.kind}:${item.dueAt ?? ""}:${item.chatId ?? ""}:${item.title}`}
              className={index === 0 ? undefined : "border-t border-border-subtle"}
            >
              <ListRowLayout label={item.title} description={kinLeadTrackingDetail(item)} />
            </View>
          ))
        )}
      </ListSection>
    </>
  );
}
