import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { KIN_RETRY } from "@t3tools/client-runtime/kin/kinAnswers";
import {
  createKinGitHubActions,
  KIN_GITHUB_COPY as COPY,
  kinGitHubRow,
  kinGitHubSheet,
} from "@t3tools/client-runtime/kin/kinGitHub";
import type { EnvironmentId, KinGitHubStatus, KinOrgId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useId, useState } from "react";

import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { useAtomCommand } from "../state/use-atom-command";
import { KinConfirm } from "./KinConfirm";
import { kinClient } from "./kinClient";
import { useKinOwnerLevel } from "./useKinOwnerLevel";

const TONE_BADGE = {
  ok: "success",
  attention: "warning",
  error: "error",
  muted: "outline",
} as const;

type Actions = ReturnType<typeof createKinGitHubActions>;

/** Settings → Connections → GitHub, for the owner and co-owners only. */
export function KinGitHubConnect(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
}) {
  return useKinOwnerLevel(props.environmentId) ? <GitHubSection {...props} /> : null;
}

function GitHubSection(props: { readonly environmentId: EnvironmentId; readonly orgId: KinOrgId }) {
  const { environmentId, orgId } = props;
  const statusAtom = kinClient.github({ environmentId, input: { orgId } });
  const result = useAtomValue(statusAtom);
  const reload = useAtomRefresh(statusAtom);
  const status = Option.getOrNull(AsyncResult.value(result));
  const start = useAtomCommand(kinClient.githubStart, { reportFailure: false });
  const cancel = useAtomCommand(kinClient.githubCancel, { reportFailure: false });
  const disconnect = useAtomCommand(kinClient.githubDisconnect, { reportFailure: false });
  const actions = createKinGitHubActions({
    orgId,
    start: (input) => start({ environmentId, input }),
    cancel: (input) => cancel({ environmentId, input }),
    disconnect: (input) => disconnect({ environmentId, input }),
    refresh: reload,
  });
  const [sheet, setSheet] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const row = status === null ? null : kinGitHubRow(status);

  return (
    <>
      <SettingsSection title={COPY.title}>
        {status === null || row === null ? (
          AsyncResult.isFailure(result) ? (
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <p className="text-sm text-destructive-foreground">{COPY.loadFailed}</p>
              <Button size="xs" variant="outline" onClick={reload}>
                {KIN_RETRY}
              </Button>
            </div>
          ) : (
            <p className="px-4 py-3 text-sm text-muted-foreground">Loading…</p>
          )
        ) : (
          <SettingsRow
            title={COPY.title}
            description={row.detail}
            status={<Badge variant={TONE_BADGE[row.tone]}>{row.label}</Badge>}
            control={
              <div className="flex gap-2">
                {row.action === "reconnect" ? (
                  <Button size="xs" variant="outline" onClick={() => setConfirming(true)}>
                    {COPY.disconnect}
                  </Button>
                ) : null}
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => {
                    setProblem(null);
                    if (row.action === "disconnect") setConfirming(true);
                    else setSheet(true);
                  }}
                >
                  {row.action === "disconnect"
                    ? COPY.disconnect
                    : row.action === "reconnect"
                      ? COPY.reconnect
                      : row.action === "waiting"
                        ? COPY.enterCode
                        : COPY.connect}
                </Button>
              </div>
            }
          />
        )}
        {problem === null ? null : (
          <div className="px-4 pb-3">
            <Alert variant="error">
              <AlertDescription>{problem}</AlertDescription>
            </Alert>
          </div>
        )}
      </SettingsSection>
      {sheet ? (
        <ConnectDialog status={status} actions={actions} onClose={() => setSheet(false)} />
      ) : null}
      <KinConfirm
        ask={
          confirming && status?.account != null
            ? {
                title: COPY.disconnectTitle,
                detail: COPY.disconnectDetail(status.account.login),
                action: COPY.disconnect,
                destructive: true,
              }
            : null
        }
        onConfirm={() => {
          setConfirming(false);
          void actions.disconnect().then((outcome) => {
            if (!outcome.ok) setProblem(outcome.problem);
          });
        }}
        onClose={() => setConfirming(false)}
      />
    </>
  );
}

function ConnectDialog(props: {
  readonly status: KinGitHubStatus | null;
  readonly actions: Actions;
  readonly onClose: () => void;
}) {
  const { actions } = props;
  const step = kinGitHubSheet(props.status);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [withToken, setWithToken] = useState(false);
  const [token, setToken] = useState("");
  const [copied, setCopied] = useState(false);
  const tokenId = useId();

  const run = async (sent: () => ReturnType<Actions["getCode"]>) => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const outcome = await sent();
    setBusy(false);
    if (!outcome.ok) setProblem(outcome.problem);
    else setToken("");
  };
  const close = () => {
    if (step.step === "code") void actions.cancel();
    props.onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <DialogPopup className="max-w-lg">
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            if (step.step !== "start") return;
            void run(withToken ? () => actions.connectWithToken(token) : actions.getCode);
          }}
        >
          <DialogHeader>
            <DialogTitle>{COPY.sheetTitle}</DialogTitle>
            <DialogDescription>{COPY.intro}</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              {step.step === "code" ? (
                <div className="flex flex-col items-center gap-3 py-2 text-center">
                  <p className="text-sm text-muted-foreground">{COPY.enterCode}</p>
                  <p
                    className="font-mono text-3xl font-semibold tracking-widest text-foreground"
                    aria-label={`Code ${step.code.split("").join(" ")}`}
                  >
                    {step.code}
                  </p>
                  <div className="flex flex-wrap justify-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() =>
                        void navigator.clipboard.writeText(step.code).then(() => setCopied(true))
                      }
                    >
                      {copied ? COPY.copied : COPY.copy}
                    </Button>
                    <Button
                      type="button"
                      onClick={() => window.open(step.url, "_blank", "noopener,noreferrer")}
                    >
                      {COPY.openGitHub}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">{COPY.codeHint}</p>
                  <p className="text-sm text-muted-foreground" aria-live="polite">
                    {COPY.waiting}
                  </p>
                </div>
              ) : step.step === "done" ? (
                <p className="text-sm text-foreground" aria-live="polite">
                  {step.detail}
                </p>
              ) : withToken ? (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={tokenId}>{COPY.tokenLabel}</Label>
                  <Input
                    id={tokenId}
                    type="password"
                    value={token}
                    placeholder={COPY.tokenPlaceholder}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => setToken(event.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">{COPY.tokenHint}</p>
                </div>
              ) : null}
              {step.step === "start" && step.failed !== null && problem === null ? (
                <Alert variant="error">
                  <AlertDescription>{step.failed}</AlertDescription>
                </Alert>
              ) : null}
              {problem === null ? null : (
                <Alert variant="error">
                  <AlertDescription>{problem}</AlertDescription>
                </Alert>
              )}
              {step.step === "start" ? (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  className="self-start"
                  disabled={busy}
                  onClick={() => {
                    setProblem(null);
                    setWithToken(!withToken);
                  }}
                >
                  {withToken ? COPY.codeInstead : COPY.tokenInstead}
                </Button>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            {step.step === "done" ? (
              <Button type="button" onClick={props.onClose}>
                {COPY.done}
              </Button>
            ) : (
              <>
                <Button type="button" variant="outline" disabled={busy} onClick={close}>
                  {COPY.cancel}
                </Button>
                {step.step === "start" ? (
                  <Button type="submit" disabled={busy} aria-busy={busy}>
                    {busy
                      ? withToken
                        ? COPY.connecting
                        : COPY.gettingCode
                      : withToken
                        ? COPY.tokenConnect
                        : COPY.getCode}
                  </Button>
                ) : null}
              </>
            )}
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
