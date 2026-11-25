import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { kinAccessAtom } from "@t3tools/client-runtime/kin/kinAccess";
import { kinFailureText, KIN_RETRY } from "@t3tools/client-runtime/kin/kinAnswers";
import {
  KIN_MY_MAILBOX_COPY as COPY,
  kinMyMailboxes,
  kinMyMailboxLine,
  kinOwnMailboxReads,
} from "@t3tools/client-runtime/kin/kinConnections";
import type { KinConnectionId, KinConnectionPreset, KinOwnMailbox } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { View } from "react-native";

import { AppActivityIndicator } from "../../../components/ui/AppActivityIndicator";
import { AppBar } from "../../../components/ui/AppBar";
import * as Dialog from "../../../components/ui/Dialog";
import { ListActionRow } from "../../../components/ui/ListActionRow";
import { ListSection } from "../../../components/ui/ListSection";
import { Notice } from "../../../components/ui/Notice";
import { ScreenContent } from "../../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../../components/ui/ScreenScrollView";
import { connectionAtomRuntime } from "../../../connection/runtime";
import { useAtomCommand } from "../../../state/use-atom-command";
import { kinClient } from "../state/kinClient";
import { kinSignInInApp, kinSignInReturn } from "./kinConnectionSignIn";
import {
  decodeConnectionsTarget,
  KinConnectionsMissing,
  type KinConnectionsParams,
  type KinConnectionsTarget,
} from "./kinConnectionTarget";

/** Settings › Your mailbox: anyone's own Google or Microsoft mail, connected and disconnected here. */
export function KinMyMailboxScreen({ route }: StaticScreenProps<KinConnectionsParams>) {
  const target = decodeConnectionsTarget(route.params);
  return target === null ? (
    <KinConnectionsMissing title={COPY.title} />
  ) : (
    <MyMailbox target={target} />
  );
}

function MyMailbox(props: { readonly target: KinConnectionsTarget }) {
  const navigation = useNavigation();
  const { environmentId, orgId } = props.target;
  const atom = kinClient.myMailbox({ environmentId, input: { orgId } });
  const result = useAtomValue(atom);
  const reload = useAtomRefresh(atom);
  const view = Option.getOrNull(AsyncResult.value(result));
  const start = useAtomCommand(kinClient.myMailboxSignInStart, { reportFailure: false });
  const finish = useAtomCommand(kinClient.myMailboxSignInFinish, { reportFailure: false });
  const remove = useAtomCommand(kinClient.myMailboxRemove, { reportFailure: false });
  const move = useAtomCommand(kinClient.mailboxMove, { reportFailure: false });
  const canMove = useAtomValue(kinClient.mailboxMove.permissionAtom(environmentId));
  const viewer = useAtomValue(kinAccessAtom(connectionAtomRuntime, environmentId));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const all = view === null ? [] : kinMyMailboxes(view);
  /** A first mailbox, another beside those connected, or one of them again. */
  const signIn = async (service: KinConnectionPreset, again?: KinConnectionId) => {
    setBusy(true);
    setProblem(null);
    const started = await start({
      environmentId,
      input: {
        orgId,
        service,
        returnTo: kinSignInReturn(),
        ...(again !== undefined
          ? { connectionId: again }
          : all.length > 0
            ? { another: true }
            : {}),
      },
    });
    if (!AsyncResult.isSuccess(started)) {
      setBusy(false);
      setProblem(kinFailureText(started, "start the sign-in"));
      return;
    }
    const response = await kinSignInInApp(started.value.authorizationUrl);
    const done =
      response === null ? null : await finish({ environmentId, input: { orgId, response } });
    setBusy(false);
    if (done === null) return;
    if (!AsyncResult.isSuccess(done)) setProblem(kinFailureText(done, "finish the sign-in"));
    // A member's screen hears no "connections" refresh, so it reads its own list again.
    else reload();
  };
  const disconnect = async (connectionId: KinConnectionId) => {
    setBusy(true);
    setProblem(null);
    const done = await remove({ environmentId, input: { orgId, connectionId } });
    setBusy(false);
    if (!AsyncResult.isSuccess(done)) setProblem(kinFailureText(done, "disconnect your mailbox"));
    else reload();
  };

  const line = view === null ? null : kinMyMailboxLine(view);
  const confirmGive = (connected: KinOwnMailbox) => {
    // iOS cuts an alert title after two lines, so a long address goes in the message.
    Dialog.alert(
      `${COPY.makeCompanys}?`,
      `${connected.account ?? COPY.title}\n\n${COPY.makeCompanysDetail}`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: COPY.makeCompanysAction,
          onPress: () => {
            setBusy(true);
            setProblem(null);
            void move({
              environmentId,
              input: { orgId, connectionId: connected.connectionId, to: "company" },
            }).then((done) => {
              setBusy(false);
              if (!AsyncResult.isSuccess(done)) setProblem(kinFailureText(done, COPY.moving));
            });
          },
        },
      ],
    );
  };
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar title={COPY.title} onBack={() => navigation.goBack()} />
      <ScreenContent surface="screen">
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 20 }}
        >
          {problem === null ? null : <Notice tone="danger" message={problem} />}
          {view === null || line === null ? (
            AsyncResult.isFailure(result) ? (
              <Notice
                tone="danger"
                message={COPY.loadFailed}
                action={{ label: KIN_RETRY, onPress: reload }}
              />
            ) : (
              <AppActivityIndicator />
            )
          ) : all.length === 0 ? (
            <ListSection footer={line.text}>
              {view.services.map((service) => (
                <ListActionRow
                  key={service.service}
                  label={COPY.connect(service.label)}
                  {...(service.ready ? {} : { description: COPY.notReady(service.label) })}
                  disabled={!service.ready}
                  loading={busy}
                  onPress={() => void signIn(service.service)}
                />
              ))}
            </ListSection>
          ) : (
            <>
              {all.map((mailbox, index) => (
                <ListSection
                  key={mailbox.connectionId}
                  title={`${mailbox.account ?? COPY.title} · ${COPY.yours}`}
                  {...(index === all.length - 1
                    ? { footer: `${line.text} ${kinOwnMailboxReads(viewer, all.length)}` }
                    : {})}
                >
                  {mailbox.state === "needs_sign_in" && mailbox.preset !== null ? (
                    <ListActionRow
                      label={COPY.signInAgain}
                      loading={busy}
                      onPress={() => void signIn(mailbox.preset!, mailbox.connectionId)}
                    />
                  ) : null}
                  {canMove ? (
                    <ListActionRow
                      label={COPY.makeCompanys}
                      loading={busy}
                      onPress={() => confirmGive(mailbox)}
                    />
                  ) : null}
                  <ListActionRow
                    label={COPY.disconnect}
                    tone="danger"
                    loading={busy}
                    onPress={() => void disconnect(mailbox.connectionId)}
                  />
                </ListSection>
              ))}
              <ListSection title={COPY.connectAnother}>
                {view.services.map((service) => (
                  <ListActionRow
                    key={service.service}
                    label={COPY.connect(service.label)}
                    {...(service.ready ? {} : { description: COPY.notReady(service.label) })}
                    disabled={!service.ready}
                    loading={busy}
                    onPress={() => void signIn(service.service)}
                  />
                ))}
              </ListSection>
            </>
          )}
        </ScreenScrollView>
      </ScreenContent>
    </View>
  );
}
