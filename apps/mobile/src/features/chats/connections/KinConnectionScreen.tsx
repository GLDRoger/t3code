import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  KIN_CONNECTIONS_COPY as COPY,
  createKinConnectionActions,
  kinAcceptAll,
  kinCallRow,
  kinConnectionChange,
  kinConnectionStatus,
  kinSuggestedModes,
  kinToolRows,
  kinToolSwitch,
  type KinToolRow,
} from "@t3tools/client-runtime/kin/kinConnections";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { KinConnectionId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { View } from "react-native";

import { AppActivityIndicator } from "../../../components/ui/AppActivityIndicator";
import { AppBar } from "../../../components/ui/AppBar";
import { AppText as Text } from "../../../components/ui/AppText";
import * as Dialog from "../../../components/ui/Dialog";
import { ErrorBanner } from "../../../components/ui/ErrorBanner";
import { ListActionRow } from "../../../components/ui/ListActionRow";
import { ListRowLayout } from "../../../components/ui/ListRowLayout";
import { ListSection } from "../../../components/ui/ListSection";
import { ListToggleRow } from "../../../components/ui/ListToggleRow";
import { Notice } from "../../../components/ui/Notice";
import { ScreenContent } from "../../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../../components/ui/ScreenScrollView";
import { useNowMinuteMs } from "../../../lib/clock";
import { useAtomCommand } from "../../../state/use-atom-command";
import { kinClient } from "../state/kinClient";
import {
  decodeConnectionId,
  decodeConnectionsTarget,
  KinConnectionsMissing,
  type KinConnectionParams,
  type KinConnectionsTarget,
} from "./kinConnectionTarget";

/** One connection as its record: how it stands, its tools inline, recent use, and its controls. */
export function KinConnectionScreen({ route }: StaticScreenProps<KinConnectionParams>) {
  const target = decodeConnectionsTarget(route.params);
  const connectionId = decodeConnectionId(route.params);
  return target === null || connectionId === null ? (
    <KinConnectionsMissing title={COPY.title} />
  ) : (
    <ConnectionRecord params={route.params} target={target} connectionId={connectionId} />
  );
}

function ConnectionRecord(props: {
  readonly params: KinConnectionParams;
  readonly target: KinConnectionsTarget;
  readonly connectionId: KinConnectionId;
}) {
  const navigation = useNavigation();
  const { environmentId, orgId } = props.target;
  const ref = { orgId, connectionId: props.connectionId };
  const detailAtom = kinClient.connection({ environmentId, input: ref });
  const result = useAtomValue(detailAtom);
  const reload = useAtomRefresh(detailAtom);
  const detail = Option.getOrNull(AsyncResult.value(result));
  const calls = Option.getOrNull(
    AsyncResult.value(
      useAtomValue(kinClient.connectionCalls({ environmentId, input: { ...ref, limit: 20 } })),
    ),
  );
  const nowMs = useNowMinuteMs();
  const setModes = useAtomCommand(kinClient.connectionSetToolModes, { reportFailure: false });
  const accept = useAtomCommand(kinClient.connectionAccept, { reportFailure: false });
  const refresh = useAtomCommand(kinClient.connectionRefresh, { reportFailure: false });
  const update = useAtomCommand(kinClient.connectionUpdate, { reportFailure: false });
  const setReach = useAtomCommand(kinClient.connectionSetReach, { reportFailure: false });
  const add = useAtomCommand(kinClient.connectionAdd, { reportFailure: false });
  const remove = useAtomCommand(kinClient.connectionRemove, { reportFailure: false });
  const actions = createKinConnectionActions({
    orgId,
    add: (input) => add({ environmentId, input }),
    remove: (input) => remove({ environmentId, input }),
    refresh: reload,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const run = async (
    key: string,
    doing: string,
    sent: () => Promise<AtomCommandResult<unknown, unknown>>,
  ) => {
    if (busy !== null) return;
    setBusy(key);
    setProblem(null);
    const failed = await kinConnectionChange(sent(), doing);
    setBusy(null);
    reload();
    setProblem(failed);
  };

  if (detail === null)
    return (
      <View collapsable={false} className="flex-1 bg-screen">
        <AppBar title={COPY.title} onBack={() => navigation.goBack()} />
        <ScreenContent surface="screen">
          <View className="p-4">
            {AsyncResult.isFailure(result) ? (
              <Notice
                tone="danger"
                message="Couldn't load this connection"
                action={{ label: "Try again", onPress: reload }}
              />
            ) : (
              <AppActivityIndicator />
            )}
          </View>
        </ScreenContent>
      </View>
    );

  const { connection } = detail;
  const status = kinConnectionStatus(connection);
  const rows = kinToolRows(detail.tools);
  const suggested = kinSuggestedModes(rows);
  const changed = rows.filter((row) => row.state === "changed");
  const switchTool = (row: KinToolRow, on: boolean) =>
    void run(`tool:${row.name}`, "change that tool", () =>
      setModes({ environmentId, input: { ...ref, modes: kinToolSwitch(row, on) } }),
    );
  const confirmRemove = () =>
    Dialog.alert(COPY.removeTitle(connection.label), COPY.removeDetail, [
      { text: "Cancel", style: "cancel" },
      {
        text: COPY.removeConfirm,
        style: "destructive",
        onPress: () =>
          void actions.remove(props.connectionId).then((outcome) => {
            if (outcome.ok) navigation.goBack();
            else setProblem(outcome.problem);
          }),
      },
    ]);

  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar title={connection.label} onBack={() => navigation.goBack()} />
      <ScreenContent surface="screen">
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 20 }}
        >
          <ListSection>
            <View accessible className="bg-grouped-card">
              <ListRowLayout
                icon="link"
                label={status.label}
                description={status.detail}
                detail={connection.urlHost}
              />
            </View>
          </ListSection>
          {problem === null ? null : <ErrorBanner message={problem} />}

          <ListSection title={COPY.toolsTitle} footer={COPY.toolsDetail}>
            {changed.length > 1 ? (
              <ListActionRow
                label={COPY.acceptAll}
                loading={busy === "accept"}
                disabled={busy !== null}
                onPress={() =>
                  void run("accept", "allow the changes", () =>
                    accept({ environmentId, input: kinAcceptAll(ref, connection, rows) }),
                  )
                }
              />
            ) : null}
            {suggested.length > 0 ? (
              <ListActionRow
                label={`${COPY.suggested} (${suggested.length})`}
                loading={busy === "suggested"}
                disabled={busy !== null}
                onPress={() =>
                  void run("suggested", "turn those on", () =>
                    setModes({ environmentId, input: { ...ref, modes: suggested } }),
                  )
                }
              />
            ) : null}
            {rows.length === 0 ? (
              <View className="bg-grouped-card">
                <ListRowLayout label={COPY.noTools} />
              </View>
            ) : (
              rows.map((row) => (
                <View key={row.name}>
                  <ListToggleRow
                    label={row.title}
                    description={toolLine(row)}
                    value={row.on}
                    disabled={busy !== null}
                    onValueChange={(on) => switchTool(row, on)}
                  />
                  {row.change === null ? null : (
                    <>
                      <View className="gap-2 bg-grouped-card px-4 pb-3">
                        <Text textRole="footnote" className="text-foreground-muted">
                          {COPY.changedDetail}
                        </Text>
                        <Text textRole="footnote" className="text-foreground-muted">
                          Before: {row.change.before ?? "No description."}
                        </Text>
                        <Text textRole="footnote" className="text-foreground">
                          Now: {row.change.after ?? "No description."}
                        </Text>
                        {row.change.inputsChanged ? (
                          <Text textRole="footnote" className="text-foreground">
                            What it takes changed too.
                          </Text>
                        ) : null}
                        {row.change.labelsChanged ? (
                          <Text textRole="footnote" className="text-foreground">
                            What the service says it does changed too.
                          </Text>
                        ) : null}
                      </View>
                      <ListActionRow
                        label={COPY.accept}
                        loading={busy === `accept:${row.name}`}
                        disabled={busy !== null}
                        onPress={() =>
                          void run(`accept:${row.name}`, "allow the new version", () =>
                            accept({
                              environmentId,
                              input: { ...ref, tools: [{ tool: row.name, digest: row.digest }] },
                            }),
                          )
                        }
                      />
                    </>
                  )}
                </View>
              ))
            )}
            <ListActionRow
              label={busy === "refresh" ? COPY.refreshing : COPY.refresh}
              loading={busy === "refresh"}
              disabled={busy !== null}
              onPress={() =>
                void run("refresh", "check for changes", () =>
                  refresh({ environmentId, input: ref }),
                )
              }
            />
          </ListSection>

          <ListSection title={COPY.callsTitle}>
            {calls === null ? (
              <AppActivityIndicator />
            ) : calls.calls.length === 0 ? (
              <View className="bg-grouped-card">
                <ListRowLayout label={COPY.noCalls} />
              </View>
            ) : (
              calls.calls.map((call) => {
                const line = kinCallRow(call, new Date(nowMs));
                return (
                  <View key={line.key} accessible className="bg-grouped-card">
                    <ListRowLayout
                      icon={line.ok ? "checkmark.circle" : "xmark.circle.fill"}
                      label={line.title}
                      description={line.detail}
                      detail={line.time}
                    />
                  </View>
                );
              })
            )}
          </ListSection>

          <ListSection footer={COPY.reachDetail}>
            <ListToggleRow
              label={COPY.reachTitle}
              value={connection.reach === "closed"}
              disabled={busy !== null}
              onValueChange={(closed) =>
                void run("reach", "change that", () =>
                  setReach({ environmentId, input: { ...ref, reach: closed ? "closed" : "open" } }),
                )
              }
            />
          </ListSection>

          <ListSection>
            <ListActionRow
              label={COPY.rename}
              onPress={() =>
                navigation.navigate("KinConnectionEdit", { ...props.params, edit: "rename" })
              }
            />
            {connection.auth === "key" ? (
              <ListActionRow
                label={COPY.replaceKey}
                onPress={() =>
                  navigation.navigate("KinConnectionEdit", { ...props.params, edit: "key" })
                }
              />
            ) : null}
            <ListActionRow
              label={connection.paused ? COPY.resume : COPY.pause}
              loading={busy === "pause"}
              disabled={busy !== null}
              onPress={() =>
                void run("pause", connection.paused ? "resume it" : "pause it", () =>
                  update({ environmentId, input: { ...ref, paused: !connection.paused } }),
                )
              }
            />
            <ListActionRow
              tone="danger"
              label={COPY.remove}
              disabled={busy !== null}
              onPress={confirmRemove}
            />
          </ListSection>
        </ScreenScrollView>
      </ScreenContent>
    </View>
  );
}

const toolLine = (row: KinToolRow) =>
  [
    row.state === "changed" ? COPY.changedTitle : null,
    row.change === null ? row.description : null,
    row.openWeb ? COPY.openWeb : null,
  ]
    .filter((part): part is string => part !== null && part !== "")
    .join(" · ") || undefined;
