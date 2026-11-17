import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { KIN_RETRY } from "@t3tools/client-runtime/kin/kinAnswers";
import {
  createKinGitHubActions,
  createKinGitHubRepoActions,
  createKinGitHubAppRepoActions,
  KIN_GITHUB_AGENTS_COPY as AGENTS,
  KIN_GITHUB_APP_REPOS_COPY as PICK,
  KIN_GITHUB_COPY as COPY,
  KIN_GITHUB_WATCH_COPY as WATCH,
  kinGitHubAccountRepos,
  kinGitHubAccountRows,
  kinGitHubAccountsHint,
  kinGitHubAgentsView,
  kinGitHubRow,
  kinGitHubSheet,
  kinGitHubWatchLine,
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
import { Switch } from "../components/ui/switch";
import { useAtomCommand } from "../state/use-atom-command";
import { KinConfirm } from "./KinConfirm";
import { kinClient } from "./kinClient";
import { useNowMinuteMs } from "./useKinClock";
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
            title={row.title}
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
        {status?.account != null &&
        status.account.problem === null &&
        status.watch !== undefined ? (
          <WatchedRepos environmentId={environmentId} orgId={orgId} status={status} />
        ) : null}
        {status?.agents === undefined ? null : (
          <AgentIdentity
            environmentId={environmentId}
            orgId={orgId}
            status={status}
            agents={status.agents}
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

/** Who agents work as on GitHub, where the App is missing, and what they lately did as the owner. */
function AgentIdentity(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly status: KinGitHubStatus;
  readonly agents: NonNullable<KinGitHubStatus["agents"]>;
}) {
  const now = useNowMinuteMs();
  const view = kinGitHubAgentsView(props.agents, props.status.account?.login ?? null, now);
  const rows = kinGitHubAccountRows(props.agents);
  const hint = kinGitHubAccountsHint(rows);
  const [picking, setPicking] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-3 border-t px-4 py-3">
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">{view.headline}</p>
        <p className="text-sm text-muted-foreground">{view.detail}</p>
      </div>
      {rows.length === 0 ? null : (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium text-muted-foreground">{AGENTS.accountsTitle}</p>
          <ul className="flex flex-col divide-y rounded-md border">
            {rows.map((row) => (
              <li
                key={row.key}
                className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-x-4"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium">{row.account}</span>
                    <Badge variant={TONE_BADGE[row.tone]}>{row.label}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">{row.detail}</p>
                </div>
                {row.action === null && !row.pickable ? null : (
                  <div className="flex shrink-0 flex-wrap gap-2">
                    {row.pickable ? (
                      <Button
                        size="xs"
                        variant="outline"
                        aria-expanded={picking === row.key}
                        onClick={() => setPicking(picking === row.key ? null : row.key)}
                      >
                        {picking === row.key ? PICK.hide : PICK.choose(row.watched)}
                      </Button>
                    ) : null}
                    {row.action === null ? null : (
                      <Button
                        size="xs"
                        variant="outline"
                        render={
                          <a href={row.action.url} target="_blank" rel="noreferrer noopener" />
                        }
                      >
                        {row.action.label}
                      </Button>
                    )}
                  </div>
                )}
                {picking === row.key ? (
                  <AccountRepos
                    environmentId={props.environmentId}
                    orgId={props.orgId}
                    account={row.account}
                    settingsUrl={row.settingsUrl}
                  />
                ) : null}
              </li>
            ))}
          </ul>
          {hint === null ? null : <p className="text-xs text-muted-foreground">{hint}</p>}
        </div>
      )}
      {view.installUrl === null ? null : (
        <div>
          <Button
            size="xs"
            variant="outline"
            render={<a href={view.installUrl} target="_blank" rel="noreferrer noopener" />}
          >
            {AGENTS.install}
          </Button>
        </div>
      )}
      {view.uses.length === 0 ? null : (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium text-muted-foreground">{AGENTS.usesTitle}</p>
          <ul className="flex flex-col divide-y rounded-md border">
            {view.uses.map((use) => (
              <li key={use.key} className="flex min-w-0 flex-col gap-0.5 px-3 py-2">
                <span className="text-xs text-muted-foreground">{use.line}</span>
                <code className="truncate font-mono text-xs">{use.command}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** One account's watched repos, each with a switch that puts the App on it or takes it off. */
function AccountRepos(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly account: string;
  readonly settingsUrl: string | null;
}) {
  const { environmentId, orgId, account } = props;
  const reposAtom = kinClient.githubRepos({ environmentId, input: { orgId } });
  const result = useAtomValue(reposAtom);
  const reload = useAtomRefresh(reposAtom);
  const reloadStatus = useAtomRefresh(kinClient.github({ environmentId, input: { orgId } }));
  const set = useAtomCommand(kinClient.githubAppReposSet, { reportFailure: false });
  const change = createKinGitHubAppRepoActions({
    orgId,
    set: (input) => set({ environmentId, input }),
    refresh: () => {
      reload();
      reloadStatus();
    },
  });
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const searchId = useId();
  const all = Option.getOrNull(AsyncResult.value(result))?.repos ?? null;
  if (all === null)
    return AsyncResult.isFailure(result) ? (
      <div className="flex items-center justify-between gap-3 sm:basis-full">
        <p className="text-sm text-destructive-foreground">{WATCH.loadFailed}</p>
        <Button size="xs" variant="outline" onClick={reload}>
          {KIN_RETRY}
        </Button>
      </div>
    ) : (
      <p className="text-sm text-muted-foreground sm:basis-full">Loading…</p>
    );
  const mine = kinGitHubAccountRepos(all, account, "");
  const shown = kinGitHubAccountRepos(all, account, query);
  const on = mine.filter((repo) => repo.agentsAs === "app").map((repo) => repo.repo);
  const off = mine.filter((repo) => repo.agentsAs !== "app").map((repo) => repo.repo);
  const run = (repos: ReadonlyArray<string>, putOn: boolean) => {
    if (busy || repos.length === 0) return;
    setBusy(true);
    setProblem(null);
    void change(account, repos, putOn).then((outcome) => {
      setBusy(false);
      setProblem(outcome.problem);
    });
  };
  return (
    <div className="flex flex-col gap-2 pt-1 sm:basis-full">
      <p className="text-xs text-muted-foreground">{PICK.hint}</p>
      <div className="flex flex-wrap items-center gap-2">
        {mine.length > 8 ? (
          <div className="min-w-40 flex-1">
            <Label htmlFor={searchId} className="sr-only">
              {PICK.search}
            </Label>
            <Input
              id={searchId}
              size="sm"
              type="search"
              placeholder={PICK.search}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        ) : null}
        <Button
          size="xs"
          variant="outline"
          disabled={busy || off.length === 0}
          onClick={() => run(off, true)}
        >
          {PICK.addAll}
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={busy || on.length === 0}
          onClick={() => run(on, false)}
        >
          {PICK.removeAll}
        </Button>
      </div>
      {shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">{PICK.none}</p>
      ) : (
        <ul className="flex max-h-80 flex-col divide-y overflow-y-auto rounded-md border">
          {shown.map((repo) => (
            <li
              key={repo.repo}
              className="flex min-h-11 items-center justify-between gap-3 px-3 py-2"
            >
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-sm">{repo.repo}</span>
                <span className="text-xs text-muted-foreground">
                  {repo.agentsAs === "app" ? WATCH.asApp : WATCH.asYou}
                </span>
              </div>
              <Switch
                size="sm"
                checked={repo.agentsAs === "app"}
                disabled={busy}
                aria-label={PICK.appOn(repo.repo)}
                onCheckedChange={(checked) => run([repo.repo], checked)}
              />
            </li>
          ))}
        </ul>
      )}
      {problem === null ? null : (
        <Alert variant="error">
          <AlertDescription>
            <span>{problem}</span>
            {props.settingsUrl === null ? null : (
              <span className="mt-2 block">
                <Button
                  size="xs"
                  variant="outline"
                  render={<a href={props.settingsUrl} target="_blank" rel="noreferrer noopener" />}
                >
                  {PICK.openOnGitHub}
                </Button>
              </span>
            )}
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

/** What Kin watches with the login: one line, why a look failed, and a switch per repo. */
function WatchedRepos(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly status: KinGitHubStatus;
}) {
  const now = useNowMinuteMs();
  const { environmentId, orgId, status } = props;
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const watch = status.watch;
  if (watch === undefined) return null;
  return (
    <div className="flex flex-col gap-2 border-t px-4 py-3">
      <p className="text-sm text-muted-foreground">{kinGitHubWatchLine(watch, now)}</p>
      {watch.problem === null ? null : (
        <Alert variant="warning">
          <AlertDescription>{watch.problem}</AlertDescription>
        </Alert>
      )}
      <div>
        <Button size="xs" variant="outline" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? WATCH.hideRepos : WATCH.showRepos(watch.repos)}
        </Button>
      </div>
      {open ? (
        <RepoList environmentId={environmentId} orgId={orgId} onProblem={setProblem} />
      ) : null}
      {problem === null ? null : (
        <Alert variant="error">
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

function RepoList(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly onProblem: (problem: string | null) => void;
}) {
  const { environmentId, orgId, onProblem } = props;
  const reposAtom = kinClient.githubRepos({ environmentId, input: { orgId } });
  const result = useAtomValue(reposAtom);
  const reload = useAtomRefresh(reposAtom);
  const set = useAtomCommand(kinClient.githubReposSet, { reportFailure: false });
  const actions = createKinGitHubRepoActions({
    orgId,
    set: (input) => set({ environmentId, input }),
    refresh: reload,
  });
  const repos = Option.getOrNull(AsyncResult.value(result))?.repos ?? null;
  const settle = (outcome: Awaited<ReturnType<typeof actions.everything>>) =>
    onProblem(outcome.ok ? null : outcome.problem);
  if (repos === null)
    return AsyncResult.isFailure(result) ? (
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-destructive-foreground">{WATCH.loadFailed}</p>
        <Button size="xs" variant="outline" onClick={reload}>
          {KIN_RETRY}
        </Button>
      </div>
    ) : (
      <p className="text-sm text-muted-foreground">Loading…</p>
    );
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-muted-foreground">{WATCH.reposHint}</p>
      {repos.length === 0 ? <p className="text-sm text-muted-foreground">{WATCH.noRepos}</p> : null}
      <ul className="flex flex-col divide-y rounded-md border">
        {repos.map((repo) => (
          <li
            key={repo.repo}
            className="flex min-h-11 items-center justify-between gap-3 px-3 py-2"
          >
            <div className="flex min-w-0 flex-col">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm">{repo.repo}</span>
                {repo.fork ? <Badge variant="outline">{WATCH.fork}</Badge> : null}
              </div>
              {repo.mentions || repo.agentsAs !== undefined ? (
                <span className="text-xs text-muted-foreground">
                  {[
                    repo.agentsAs === undefined
                      ? null
                      : repo.agentsAs === "app"
                        ? WATCH.asApp
                        : WATCH.asYou,
                    repo.mentions ? WATCH.mentions : null,
                  ]
                    .filter(Boolean)
                    .join(". ")}
                </span>
              ) : null}
            </div>
            <Switch
              size="sm"
              checked={repo.watched}
              aria-label={`Watch ${repo.repo}`}
              onCheckedChange={(checked) => void actions.watch(repo, checked).then(settle)}
            />
          </li>
        ))}
      </ul>
      {repos.some((repo) => !repo.watched && !repo.fork) ? (
        <div>
          <Button
            size="xs"
            variant="outline"
            onClick={() => void actions.everything().then(settle)}
          >
            {WATCH.watchEverything}
          </Button>
        </div>
      ) : null}
    </div>
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
