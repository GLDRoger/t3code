import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { KIN_AGENTS_COPY } from "@t3tools/client-runtime/kin/kinLeadPresentation";
import {
  KIN_REACH_COPY,
  kinAgentReach,
  kinPersonReach,
  kinReachProblem,
  kinReachRows,
  type KinReachInput,
} from "@t3tools/client-runtime/kin/kinReach";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  KinLeadProfile,
  KinOrgId,
  KinPersonId,
  KinReachParty,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ListRow } from "../../components/ui/ListRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { Menu } from "../../components/ui/Menu";
import { appAtomRegistry } from "../../state/atom-registry";
import { useAtomCommand } from "../../state/use-atom-command";
import { KinAvatar } from "./components/KinAvatar";
import { kinClient } from "./state/kinClient";

interface KinReachTarget {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
}

interface KinReachChange {
  readonly a: KinReachParty;
  readonly b: KinReachParty;
  readonly names: readonly [string, string];
  readonly agent: boolean;
}

/** Owners and co-owners only, as the host's `kin.reach.*` are; anyone else is shown nothing. */
const useMayRestrict = (environmentId: EnvironmentId) =>
  useAtomValue(kinClient.reachSet.permissionAtom(environmentId));

function useKinReach({ environmentId, orgId }: KinReachTarget) {
  const reachAtom = kinClient.reach({ environmentId, input: { orgId } });
  const reach = useAtomValue(reachAtom);
  const people = useAtomValue(kinClient.people({ environmentId, input: { orgId } }));
  const leads = useAtomValue(kinClient.leads({ environmentId, input: { orgId } }));
  const heldReach = Option.getOrNull(AsyncResult.value(reach));
  const heldPeople = Option.getOrNull(AsyncResult.value(people));
  const heldLeads = Option.getOrNull(AsyncResult.value(leads));
  const input: KinReachInput | null =
    heldReach === null || heldPeople === null || heldLeads === null
      ? null
      : { reach: heldReach, people: heldPeople.people, agents: heldLeads.leads };
  const set = useAtomCommand(kinClient.reachSet, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const change = async (pair: KinReachChange, restricted: boolean) => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    const result = await set({
      environmentId,
      input: { orgId, a: pair.a, b: pair.b, restricted },
    });
    setBusy(false);
    if (AsyncResult.isSuccess(result)) {
      appAtomRegistry.refresh(reachAtom);
      const [a, b] = pair.names;
      setNote(restricted ? KIN_REACH_COPY.done(a, b) : KIN_REACH_COPY.lifted(a, b));
      return;
    }
    setNote(
      kinReachProblem(AsyncResult.isFailure(result) ? squashAtomCommandFailure(result) : null),
    );
  };

  return {
    input,
    failed:
      input === null &&
      (AsyncResult.isFailure(reach) ||
        AsyncResult.isFailure(people) ||
        AsyncResult.isFailure(leads)),
    busy,
    note,
    /** Restricting asks first; lifting needs no confirm. */
    restrict: (pair: KinReachChange) => {
      const [a, b] = pair.names;
      Dialog.confirm({
        title: KIN_REACH_COPY.confirmTitle(a, b),
        message: pair.agent
          ? KIN_REACH_COPY.confirmAgent(a, b)
          : KIN_REACH_COPY.confirmPeople(a, b),
        confirmText: KIN_REACH_COPY.restrict,
        destructive: true,
        onConfirm: () => void change(pair, true),
      });
    },
    lift: (pair: KinReachChange) => void change(pair, false),
  };
}

type KinReachState = ReturnType<typeof useKinReach>;

function Line(props: { readonly text: string }) {
  return (
    <View className="px-4 py-3">
      <Text textRole="body" className="text-foreground-muted">
        {props.text}
      </Text>
    </View>
  );
}

const waiting = (state: KinReachState) => (state.failed ? KIN_REACH_COPY.loadFailed : "Loading…");

function Rows<T>(props: {
  readonly rows: ReadonlyArray<T>;
  readonly keyOf: (row: T) => string;
  readonly render: (row: T) => React.ReactNode;
  readonly first?: boolean;
}) {
  return props.rows.map((row, index) => (
    <View
      key={props.keyOf(row)}
      className={index === 0 && props.first !== false ? undefined : "border-t border-border-subtle"}
    >
      {props.render(row)}
    </View>
  ));
}

function PickRow(props: {
  readonly label: string;
  readonly choices: ReadonlyArray<{ readonly personId: KinPersonId; readonly name: string }>;
  readonly busy: boolean;
  readonly onPick: (personId: string) => void;
}) {
  return (
    <View className="border-t border-border-subtle">
      <Menu
        title={props.label}
        accessibilityLabel={props.label}
        actions={props.choices.map((one) => ({ id: one.personId, title: one.name }))}
        onPressAction={({ nativeEvent }) => {
          if (!props.busy) props.onPick(nativeEvent.event);
        }}
      >
        <View pointerEvents="none">
          <ListRowLayout icon="person.fill.xmark" label={props.label} disabled={props.busy} />
        </View>
      </Menu>
    </View>
  );
}

/** An agent's "Who can message": who can, who is restricted, and the way to change it. */
export function KinAgentReachSection(props: {
  readonly environmentId: EnvironmentId;
  readonly lead: KinLeadProfile;
}) {
  if (!useMayRestrict(props.environmentId)) return null;
  return <AgentReachBody {...props} />;
}

function AgentReachBody(props: Parameters<typeof KinAgentReachSection>[0]) {
  const { lead } = props;
  const state = useKinReach({ environmentId: props.environmentId, orgId: lead.orgId });
  const view = state.input === null ? null : kinAgentReach(state.input, lead.agentId);
  const agent: KinReachParty = { kind: "agent", agentId: lead.agentId };
  const pairOf = (one: { readonly name: string; readonly party: KinReachParty }) => ({
    a: one.party,
    b: agent,
    names: [one.name, lead.name] as const,
    agent: true,
  });
  const intro = (lead.intro ?? "").trim();
  const footer =
    state.note ??
    (view === null
      ? undefined
      : intro === ""
        ? KIN_AGENTS_COPY.nameOnly
        : KIN_AGENTS_COPY.seesIntro(intro));
  return (
    <>
      <ListSection title={KIN_REACH_COPY.title} footer={footer}>
        {view === null ? (
          <Line text={waiting(state)} />
        ) : (
          <>
            <Line text={KIN_REACH_COPY.agentBody(lead.name)} />
            <Rows
              first={false}
              rows={view.canMessage}
              keyOf={(one) => one.personId}
              render={(one) => (
                <View className="bg-grouped-card">
                  <ListRowLayout
                    label={one.name}
                    leading={
                      <KinAvatar
                        avatar={{ kind: "person", seed: `person:${one.personId}` }}
                        size="small"
                      />
                    }
                  />
                </View>
              )}
            />
            {view.canMessage.length === 0 ? null : (
              <PickRow
                label={KIN_REACH_COPY.restrictSomeone}
                choices={view.canMessage}
                busy={state.busy}
                onPick={(id) => {
                  const one = view.canMessage.find((person) => person.personId === id);
                  if (one !== undefined) state.restrict(pairOf(one));
                }}
              />
            )}
          </>
        )}
      </ListSection>
      {view === null || view.restricted.length === 0 ? null : (
        <ListSection title={KIN_REACH_COPY.restricted}>
          <Rows
            rows={view.restricted}
            keyOf={(one) => one.personId}
            render={(one) => (
              <ListRow
                label={one.name}
                leading={
                  <KinAvatar
                    avatar={{ kind: "person", seed: `person:${one.personId}` }}
                    size="small"
                  />
                }
                detail={KIN_REACH_COPY.lift}
                disabled={state.busy}
                onPress={() => state.lift(pairOf(one))}
              />
            )}
          />
        </ListSection>
      )}
    </>
  );
}

/**
 * A person's page: each agent they can or can't message, and the people they can't. The owner
 * and co-owners only; an owner-level person can't be restricted, and their page says so.
 */
export function KinPersonReachSections(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly personId: KinPersonId;
  readonly name: string;
  readonly ownerLevel: boolean;
}) {
  if (!useMayRestrict(props.environmentId)) return null;
  if (props.ownerLevel)
    return (
      <ListSection title="People">
        <Line text={KIN_REACH_COPY.ownerLevel(props.name)} />
      </ListSection>
    );
  return <PersonReachBody {...props} />;
}

function PersonReachBody(props: Parameters<typeof KinPersonReachSections>[0]) {
  const navigation = useNavigation();
  const state = useKinReach(props);
  const view = state.input === null ? null : kinPersonReach(state.input, props.personId);
  // Someone no longer here has nothing to restrict.
  if (state.input !== null && view === null) return null;
  const self: KinReachParty = { kind: "person", personId: props.personId };
  const pairWith = (one: { readonly name: string; readonly party: KinReachParty }) => ({
    a: self,
    b: one.party,
    names: [props.name, one.name] as const,
    agent: one.party.kind === "agent",
  });
  return (
    <>
      <ListSection title="Agents">
        {view === null ? (
          <Line text={waiting(state)} />
        ) : view.agents.length === 0 ? (
          <Line text={KIN_AGENTS_COPY.none} />
        ) : (
          <Rows
            rows={view.agents}
            keyOf={(agent) => agent.agentId}
            render={(agent) => (
              <View className="flex-row items-center bg-grouped-card">
                <View className="flex-1">
                  <ListRow
                    label={agent.name}
                    description={
                      agent.restricted ? KIN_REACH_COPY.restricted : KIN_REACH_COPY.canMessage
                    }
                    onPress={() =>
                      navigation.navigate("KinLead", {
                        environmentId: props.environmentId,
                        orgId: props.orgId,
                        agentId: agent.agentId,
                      })
                    }
                  />
                </View>
                <View className="pr-2">
                  <Button
                    tone="text"
                    size="compact"
                    label={agent.restricted ? KIN_REACH_COPY.lift : KIN_REACH_COPY.restrict}
                    accessibilityLabel={`${agent.restricted ? KIN_REACH_COPY.lift : KIN_REACH_COPY.restrict} ${props.name} and ${agent.name}`}
                    disabled={state.busy}
                    onPress={() =>
                      agent.restricted
                        ? state.lift(pairWith(agent))
                        : state.restrict(pairWith(agent))
                    }
                  />
                </View>
              </View>
            )}
          />
        )}
      </ListSection>
      {view === null ? null : (
        <ListSection title="People" footer={state.note ?? undefined}>
          {view.cantMessage.length === 0 ? (
            <Line text={KIN_REACH_COPY.everyone(props.name)} />
          ) : (
            <>
              <Line text={`${KIN_REACH_COPY.cantMessage}:`} />
              <Rows
                first={false}
                rows={view.cantMessage}
                keyOf={(one) => one.personId}
                render={(one) => (
                  <ListRow
                    label={one.name}
                    leading={
                      <KinAvatar
                        avatar={{ kind: "person", seed: `person:${one.personId}` }}
                        size="small"
                      />
                    }
                    detail={KIN_REACH_COPY.lift}
                    disabled={state.busy}
                    onPress={() => state.lift(pairWith(one))}
                  />
                )}
              />
            </>
          )}
          {view.offered.length === 0 ? null : (
            <PickRow
              label={KIN_REACH_COPY.restrictWith}
              choices={view.offered}
              busy={state.busy}
              onPick={(id) => {
                const one = view.offered.find((person) => person.personId === id);
                if (one !== undefined) state.restrict(pairWith(one));
              }}
            />
          )}
        </ListSection>
      )}
    </>
  );
}

/** Team: every live restriction in the company, with who set it and when, to lift. */
export function KinReachListSection(props: KinReachTarget) {
  if (!useMayRestrict(props.environmentId)) return null;
  return <ReachListBody {...props} />;
}

function ReachListBody(props: KinReachTarget) {
  const state = useKinReach(props);
  const rows = state.input === null ? null : kinReachRows(state.input);
  return (
    <ListSection
      title={KIN_REACH_COPY.title}
      footer={
        state.note ?? (rows === null || rows.length === 0 ? undefined : KIN_REACH_COPY.allBody)
      }
    >
      {rows === null ? (
        <Line text={waiting(state)} />
      ) : rows.length === 0 ? (
        <Line text={KIN_REACH_COPY.allNone} />
      ) : (
        <Rows
          rows={rows}
          keyOf={(row) => row.key}
          render={(row) => (
            <ListRow
              label={`${row.names[0]} and ${row.names[1]}`}
              description={row.detail}
              detail={KIN_REACH_COPY.lift}
              disabled={state.busy}
              onPress={() =>
                state.lift({ a: row.a, b: row.b, names: row.names, agent: row.b.kind === "agent" })
              }
            />
          )}
        />
      )}
    </ListSection>
  );
}
