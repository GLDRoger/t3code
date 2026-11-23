import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  KIN_MY_MAILBOX_COPY as COPY,
  kinMyMailboxLine,
} from "@t3tools/client-runtime/kin/kinConnections";
import { kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import type {
  EnvironmentId,
  KinConnectionPreset,
  KinOrgId,
  KinPersonMailbox,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { useAtomCommand } from "../state/use-atom-command";
import { openSignInWindow, SignInWaiting } from "./KinConnectionSignIn";
import { kinClient } from "./kinClient";
import {
  KinSettingsLoadFailed,
  KinSettingsLoading,
  KinSettingsRow,
  KinSettingsSection,
  KinSettingsStatus,
} from "./settings/KinSettingsLayout";

type Target = { readonly environmentId: EnvironmentId; readonly orgId: KinOrgId };

/**
 * Settings › Connections › Your mailbox, for everyone: connect your own Google or Microsoft mail,
 * see which address is connected, sign in again, disconnect. Nobody else's is shown here.
 */
export function KinMyMailbox(props: Target) {
  const { environmentId, orgId } = props;
  const atom = kinClient.myMailbox({ environmentId, input: { orgId } });
  const result = useAtomValue(atom);
  const reload = useAtomRefresh(atom);
  const view = Option.getOrNull(AsyncResult.value(result));
  const start = useAtomCommand(kinClient.myMailboxSignInStart, { reportFailure: false });
  const finish = useAtomCommand(kinClient.myMailboxSignInFinish, { reportFailure: false });
  const remove = useAtomCommand(kinClient.myMailboxRemove, { reportFailure: false });
  const [waiting, setWaiting] = useState<{ host: string; url: string; opened: boolean } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (view === null)
    return (
      <KinSettingsSection title={COPY.title}>
        {AsyncResult.isFailure(result) ? (
          <KinSettingsLoadFailed onRetry={reload}>{COPY.loadFailed}</KinSettingsLoadFailed>
        ) : (
          <KinSettingsLoading />
        )}
      </KinSettingsSection>
    );
  const line = kinMyMailboxLine(view);
  const signIn = async (service: KinConnectionPreset) => {
    setBusy(true);
    setProblem(null);
    // Opened on the tap itself, so the browser lets it through; the address follows.
    const popup = openSignInWindow();
    const started = await start({
      environmentId,
      input: { orgId, service, returnTo: "web" },
    });
    setBusy(false);
    if (!AsyncResult.isSuccess(started)) {
      popup?.close();
      setProblem(kinFailureText(started, "start the sign-in"));
      return;
    }
    if (popup !== null) popup.location.href = started.value.authorizationUrl;
    setWaiting({
      host: started.value.host,
      url: started.value.authorizationUrl,
      opened: popup !== null,
    });
  };
  const disconnect = async () => {
    setBusy(true);
    setProblem(null);
    const done = await remove({ environmentId, input: { orgId } });
    setBusy(false);
    if (!AsyncResult.isSuccess(done)) setProblem(kinFailureText(done, "disconnect your mailbox"));
  };
  const connected = view.mailbox;
  return (
    <KinSettingsSection title={COPY.title} description={line.text} problem={problem}>
      {connected === null ? (
        view.services.map((service) => (
          <KinSettingsRow
            key={service.service}
            title={service.label}
            wrap
            detail={service.ready ? undefined : COPY.notReady(service.label)}
            control={
              <Button
                size="xs"
                variant="outline"
                disabled={!service.ready || busy}
                onClick={() => void signIn(service.service)}
              >
                {COPY.connect(service.label)}
              </Button>
            }
          />
        ))
      ) : (
        <KinSettingsRow
          title={connected.account ?? COPY.title}
          status={
            line._tag === "signIn" ? (
              <KinSettingsStatus tone="attention">{COPY.signInAgain}</KinSettingsStatus>
            ) : null
          }
          control={
            <div className="flex gap-1">
              {line._tag === "signIn" && connected.preset !== null ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void signIn(connected.preset!)}
                >
                  {COPY.signInAgain}
                </Button>
              ) : null}
              <Button size="xs" variant="ghost" disabled={busy} onClick={() => void disconnect()}>
                {COPY.disconnect}
              </Button>
            </div>
          }
        />
      )}
      {waiting === null ? null : (
        <div className="px-4 py-3">
          <SignInWaiting
            host={waiting.host}
            authorizationUrl={waiting.url}
            signInAddress={view.signInAddress}
            opened={waiting.opened}
            onFinish={async (response) => {
              const done = await finish({ environmentId, input: { orgId, response } });
              if (!AsyncResult.isSuccess(done)) return kinFailureText(done, "finish the sign-in");
              setWaiting(null);
              return null;
            }}
          />
        </div>
      )}
    </KinSettingsSection>
  );
}

/**
 * The owner level's view of each person's own mailbox: whose, and which address, with Disconnect.
 * Never what is in it.
 */
export function KinPeopleMailboxes(
  props: Target & { readonly mailboxes: ReadonlyArray<KinPersonMailbox> },
) {
  const { environmentId, orgId } = props;
  const people = useAtomValue(kinClient.people({ environmentId, input: { orgId } }));
  const names = new Map(
    (Option.getOrNull(AsyncResult.value(people))?.people ?? []).map((person) => [
      person.personId,
      person.displayName,
    ]),
  );
  const remove = useAtomCommand(kinClient.connectionRemove, { reportFailure: false });
  const [problem, setProblem] = useState<string | null>(null);
  if (props.mailboxes.length === 0) return null;
  return (
    <KinSettingsSection
      title={COPY.teammatesTitle}
      description={COPY.teammatesFooter}
      problem={problem}
    >
      {props.mailboxes.map((mailbox) => (
        <KinSettingsRow
          key={mailbox.connectionId}
          title={names.get(mailbox.personId) ?? mailbox.account ?? COPY.title}
          detail={mailbox.account ?? undefined}
          status={
            mailbox.state === "needs_sign_in" ? (
              <KinSettingsStatus tone="attention">{COPY.teammateNeedsSignIn}</KinSettingsStatus>
            ) : null
          }
          control={
            <Button
              size="xs"
              variant="ghost"
              onClick={() =>
                void remove({
                  environmentId,
                  input: { orgId, connectionId: mailbox.connectionId },
                }).then((done) =>
                  setProblem(
                    AsyncResult.isSuccess(done) ? null : kinFailureText(done, "disconnect it"),
                  ),
                )
              }
            >
              {COPY.disconnect}
            </Button>
          }
        />
      ))}
    </KinSettingsSection>
  );
}
