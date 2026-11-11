import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  kinRemoveAccessCopy,
  kinTeamView,
  kinTeammateActions,
  kinTeammateLeadLine,
  type KinMadeInvite,
  type KinTeammate,
} from "@t3tools/client-runtime/kin/kinTeam";
import { EnvironmentId, KinOrgId, type KinLeadProfile, type KinPersonId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRow } from "../../components/ui/ListRow";
import { ListSection } from "../../components/ui/ListSection";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { KinAvatar } from "./components/KinAvatar";
import { KinInviteLink } from "./components/KinInviteLink";
import { kinClient } from "./state/kinClient";
import { useKinTeam, type KinTeamTarget } from "./state/useKinTeam";

export type KinTeammateParams = {
  readonly environmentId: string;
  readonly orgId: string;
  /** The row's key on the Team page: a person, or an invite nobody has opened. */
  readonly teammate: string;
};

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeOrgId = Schema.decodeUnknownOption(KinOrgId);

/** One teammate: which leads they can message, their link, and the way to take access away. */
export function KinTeammateScreen({ route }: StaticScreenProps<KinTeammateParams>) {
  const navigation = useNavigation();
  const environmentId = Option.getOrNull(decodeEnvironmentId(route.params.environmentId));
  const orgId = Option.getOrNull(decodeOrgId(route.params.orgId));
  if (environmentId === null || orgId === null) {
    return (
      <Frame title="Teammate" onClose={() => navigation.goBack()}>
        <EmptyState
          variant="plain"
          title="This link doesn't name a teammate"
          detail="Open Team from your Kin chats."
        />
      </Frame>
    );
  }
  return (
    <KinTeammateBody environmentId={environmentId} orgId={orgId} rowKey={route.params.teammate} />
  );
}

function Frame(props: {
  readonly title: string;
  readonly onClose: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar title={props.title} onClose={props.onClose} />
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

function KinTeammateBody(props: KinTeamTarget & { readonly rowKey: string }) {
  const navigation = useNavigation();
  const team = useKinTeam(props);
  // Held here and nowhere else; closing the sheet drops it.
  const [made, setMade] = useState<KinMadeInvite | null>(null);
  const close = () => navigation.goBack();
  if (made !== null) {
    return (
      <Frame title="Invite link" onClose={close}>
        <KinInviteLink invite={made} environmentId={props.environmentId} />
      </Frame>
    );
  }
  const teammate =
    team.list === null
      ? null
      : (kinTeamView(team.list, team.edits, team.ownerPersonId).find(
          (row) => row.key === props.rowKey,
        ) ?? null);
  if (team.list === null || teammate === null) {
    return (
      <Frame title="Teammate" onClose={close}>
        {team.list === null && team.allowed && !team.failed ? (
          <View className="items-center py-12">
            <AppActivityIndicator />
          </View>
        ) : (
          <EmptyState
            variant="plain"
            title="This person isn't here any more"
            detail="Their invite was cancelled or has been used. Open Team to see who is on it now."
          />
        )}
      </Frame>
    );
  }
  return (
    <Frame title="Teammate" onClose={close}>
      <KinTeammateDetails
        target={props}
        teammate={teammate}
        actions={team.actions}
        problem={team.edits.problem}
        onMade={setMade}
        onClose={close}
      />
    </Frame>
  );
}

function KinTeammateDetails(props: {
  readonly target: KinTeamTarget;
  readonly teammate: KinTeammate;
  readonly actions: ReturnType<typeof useKinTeam>["actions"];
  readonly problem: string | null;
  readonly onMade: (invite: KinMadeInvite) => void;
  readonly onClose: () => void;
}) {
  const { teammate, actions } = props;
  const offered = kinTeammateActions(teammate);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const makeLink = async () => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const result = await actions.makeLink({
      displayName: teammate.name,
      personId: teammate.personId,
      replaces: teammate.inviteId,
    });
    setBusy(false);
    if (result.ok) props.onMade(result.invite);
    else setProblem(result.problem);
  };

  const askRemove = () => {
    const { personId } = teammate;
    if (personId === null) return;
    const copy = kinRemoveAccessCopy(teammate.name);
    Dialog.confirm({
      title: copy.title,
      message: copy.detail,
      confirmText: copy.confirm,
      destructive: true,
      onConfirm: () => void actions.removeAccess(personId),
    });
  };

  const shown = problem ?? props.problem;
  return (
    <>
      <View className="items-center gap-3 pt-2">
        <KinAvatar avatar={teammate.avatar} size="large" />
        <View className="items-center gap-1">
          <Text textRole="title" className="text-center font-t3-bold text-foreground">
            {teammate.name}
          </Text>
          <Text textRole="footnote" className="text-center text-foreground-muted">
            {teammate.detail}
          </Text>
        </View>
      </View>
      {shown === null ? null : <ErrorBanner message={shown} />}
      {teammate.personId === null ? (
        <ListSection
          title="Leads"
          footer={`Once ${teammate.name} joins, open a lead's details to let them message it.`}
        >
          <View className="px-4 py-3">
            <Text textRole="body" className="text-foreground-muted">
              None yet.
            </Text>
          </View>
        </ListSection>
      ) : (
        <KinTeammateLeads target={props.target} personId={teammate.personId} name={teammate.name} />
      )}
      {offered.link === null ? null : (
        <ListSection title="Invite link" footer={offered.link.hint}>
          <ListActionRow
            label={offered.link.label}
            icon="link"
            loading={busy}
            disabled={busy}
            onPress={() => void makeLink()}
          />
          {offered.cancel === null ? null : (
            <View className="border-t border-border-subtle">
              <ListActionRow
                label={offered.cancel.label}
                icon="xmark"
                disabled={busy}
                onPress={() => {
                  if (teammate.inviteId === null) return;
                  // Shown at once; the Team page says so if the host refuses.
                  void actions.cancelInvite(teammate.inviteId);
                  if (teammate.personId === null) props.onClose();
                }}
              />
            </View>
          )}
        </ListSection>
      )}
      {offered.remove ? (
        <ListSection>
          <ListActionRow
            label="Remove access"
            icon="person.fill.xmark"
            tone="danger"
            disabled={busy}
            onPress={askRemove}
          />
        </ListSection>
      ) : null}
    </>
  );
}

/** The owner's leads and whether this person can message each. A lead's own details change it. */
function KinTeammateLeads(props: {
  readonly target: KinTeamTarget;
  readonly personId: KinPersonId;
  readonly name: string;
}) {
  const { environmentId, orgId } = props.target;
  const result = useAtomValue(kinClient.leads({ environmentId, input: { orgId } }));
  const leads = Option.getOrNull(AsyncResult.value(result))?.leads ?? null;
  return (
    <ListSection
      title="Leads"
      footer={
        leads === null || leads.length === 0
          ? undefined
          : `Open a lead to change whether ${props.name} can message it.`
      }
    >
      {leads === null || leads.length === 0 ? (
        <View className="px-4 py-3">
          <Text textRole="body" className="text-foreground-muted">
            {leads !== null
              ? "You have no leads yet."
              : AsyncResult.isFailure(result)
                ? "Couldn't load your leads."
                : "Loading…"}
          </Text>
        </View>
      ) : (
        leads.map((lead, index) => (
          <View
            key={lead.agentId}
            className={index === 0 ? undefined : "border-t border-border-subtle"}
          >
            <KinTeammateLead lead={lead} personId={props.personId} environmentId={environmentId} />
          </View>
        ))
      )}
    </ListSection>
  );
}

function KinTeammateLead(props: {
  readonly lead: KinLeadProfile;
  readonly personId: KinPersonId;
  readonly environmentId: EnvironmentId;
}) {
  const navigation = useNavigation();
  const { lead, environmentId } = props;
  const access = useAtomValue(
    kinClient.leadAccess({ environmentId, input: { orgId: lead.orgId, agentId: lead.agentId } }),
  );
  const people = Option.getOrNull(AsyncResult.value(access))?.people ?? null;
  return (
    <ListRow
      label={lead.name}
      detail={
        people === null && AsyncResult.isFailure(access)
          ? undefined
          : kinTeammateLeadLine(
              people === null ? null : people.some((held) => held.personId === props.personId),
            )
      }
      onPress={() =>
        navigation.navigate("KinLead", {
          environmentId,
          orgId: lead.orgId,
          agentId: lead.agentId,
        })
      }
    />
  );
}
