import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { KIN_RETRY } from "@t3tools/client-runtime/kin/kinAnswers";
import {
  createKinGitHubActions,
  createKinGitHubRepoActions,
  createKinGitHubAppRepoActions,
  createKinGitHubAppSetupActions,
  createKinGitHubGuardActions,
  createKinGitHubHookActions,
  createKinGitHubLookActions,
  KIN_GITHUB_APP_SETUP_COPY as SETUP,
  kinGitHubAppCreatePath,
  KIN_GITHUB_AGENTS_COPY as AGENTS,
  KIN_GITHUB_APP_REPOS_COPY as PICK,
  KIN_GITHUB_COPY as COPY,
  KIN_GITHUB_GUARD_COPY as GUARD,
  KIN_GITHUB_INSTANT_COPY as INSTANT,
  type KinGitHubGuardOutcome,
  KIN_GITHUB_WATCH_COPY as WATCH,
  kinGitHubAccountRepos,
  kinGitHubAccountRows,
  kinGitHubAccountsHint,
  kinGitHubAgentsView,
  kinGitHubGuardAction,
  kinGitHubGuardLine,
  kinGitHubInstantRow,
  kinGitHubRow,
  kinGitHubRowDetail,
  kinGitHubSheet,
  kinGitHubWatchLine,
} from "@t3tools/client-runtime/kin/kinGitHub";
import type { KinConnectionTone } from "@t3tools/client-runtime/kin/kinConnections";
import type {
  EnvironmentId,
  KinGitHubAppCreateStart,
  KinGitHubStatus,
  KinOrgId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { type ReactNode, useId, useState } from "react";

import { Alert, AlertDescription } from "../components/ui/alert";
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
import {
  KinSettingsLoadFailed,
  KinSettingsLoading,
  KinSettingsPage,
  KinSettingsRow,
  KinSettingsSection,
  KinSettingsStatus,
} from "./settings/KinSettingsLayout";
import { useNowMinuteMs } from "./useKinClock";
import { useKinOwnerLevel } from "./useKinOwnerLevel";

/** A state said only when it isn't fine: problems are badges, quiet states plain text. */
function ToneStatus(props: { readonly tone: KinConnectionTone; readonly label: string }) {
  if (props.tone === "ok") return null;
  return (
    <KinSettingsStatus tone={props.tone === "muted" ? "quiet" : props.tone}>
      {props.label}
    </KinSettingsStatus>
  );
}

/** A row's name with its state beside it, so a narrow window keeps room for the text. */
function TitleWithStatus(props: {
  readonly title: string;
  readonly tone: KinConnectionTone;
  readonly label: string;
}) {
  return (
    <span className="flex flex-wrap items-center gap-2">
      {props.title}
      <ToneStatus tone={props.tone} label={props.label} />
    </span>
  );
}

/** A row's line, then its buttons under it: several buttons don't fit beside text on a phone. */
function DetailWithActions(props: { readonly detail: ReactNode; readonly actions: ReactNode }) {
  return (
    <>
      {props.detail}
      {props.actions === null ? null : (
        <span className="mt-2 flex flex-wrap gap-2">{props.actions}</span>
      )}
    </>
  );
}

type Actions = ReturnType<typeof createKinGitHubActions>;

/**
 * Settings → Connections → GitHub, for the owner and co-owners only: one row, which opens
 * GitHub's own page (`onOpen`) once there is more to see than Connect.
 */
export function KinGitHubConnect(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly onOpen?: () => void;
}) {
  return useKinOwnerLevel(props.environmentId) ? <GitHubSection {...props} /> : null;
}

/** GitHub's own page: your account, what Kin watches, who agents work as, and Disconnect last. */
export function KinGitHubPage(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
}) {
  return useKinOwnerLevel(props.environmentId) ? <GitHubSection {...props} page /> : null;
}

function GitHubSection(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly onOpen?: () => void;
  readonly page?: boolean;
}) {
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
  const more = status !== null && (status.account !== null || status.agents !== undefined);
  const connectLabel =
    row === null || row.action === "disconnect"
      ? null
      : row.action === "reconnect"
        ? COPY.reconnect
        : row.action === "waiting"
          ? COPY.enterCode
          : COPY.connect;

  const accountRow =
    status === null || row === null ? (
      AsyncResult.isFailure(result) ? (
        <KinSettingsLoadFailed onRetry={reload}>{COPY.loadFailed}</KinSettingsLoadFailed>
      ) : (
        <KinSettingsLoading rows={1} />
      )
    ) : (
      <KinSettingsRow
        title={row.title}
        wrap
        detail={kinGitHubRowDetail(status)}
        status={row.tone === "muted" ? null : <ToneStatus tone={row.tone} label={row.label} />}
        control={
          connectLabel === null ? null : (
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                setProblem(null);
                setSheet(true);
              }}
            >
              {connectLabel}
            </Button>
          )
        }
        {...(props.page !== true && props.onOpen !== undefined && more
          ? { onOpen: props.onOpen, openLabel: `${COPY.open}: ${COPY.title}` }
          : {})}
      />
    );

  return (
    <>
      {props.page === true ? (
        <KinSettingsPage purpose={COPY.purpose}>
          <KinSettingsSection title={COPY.accountTitle} problem={problem}>
            {accountRow}
          </KinSettingsSection>
          {status?.account != null &&
          status.account.problem === null &&
          status.watch !== undefined ? (
            <KinSettingsSection title={WATCH.reposTitle}>
              <WatchedRepos environmentId={environmentId} orgId={orgId} status={status} />
            </KinSettingsSection>
          ) : null}
          {status?.agents === undefined ? null : (
            <AgentIdentity
              environmentId={environmentId}
              orgId={orgId}
              status={status}
              agents={status.agents}
            />
          )}
          {status?.account == null ? null : (
            <KinSettingsSection title={COPY.disconnect}>
              <KinSettingsRow
                title={COPY.disconnectRow}
                wrap
                detail={COPY.disconnectRowDetail}
                control={
                  <Button
                    size="sm"
                    variant="destructive-outline"
                    onClick={() => setConfirming(true)}
                  >
                    {COPY.disconnect}
                  </Button>
                }
              />
            </KinSettingsSection>
          )}
        </KinSettingsPage>
      ) : (
        <KinSettingsSection title={COPY.title} problem={problem}>
          {accountRow}
        </KinSettingsSection>
      )}
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
    <>
      <KinSettingsSection title={AGENTS.title}>
        <AppSetUp
          environmentId={props.environmentId}
          orgId={props.orgId}
          view={view}
          install={
            view.installUrl === null ? null : (
              <Button
                size="xs"
                variant="outline"
                render={<a href={view.installUrl} target="_blank" rel="noreferrer noopener" />}
              >
                {AGENTS.install}
              </Button>
            )
          }
        />
        <KinGitHubInstantLine
          environmentId={props.environmentId}
          orgId={props.orgId}
          agents={props.agents}
          now={now}
        />
      </KinSettingsSection>
      {rows.length === 0 ? null : (
        <KinSettingsSection title={AGENTS.accountsTitle} description={hint ?? undefined}>
          {rows.map((row) => (
            <div key={row.key}>
              <KinSettingsRow
                title={<TitleWithStatus title={row.account} tone={row.tone} label={row.label} />}
                wrap
                detail={
                  <DetailWithActions
                    detail={row.detail}
                    actions={
                      row.action === null && !row.pickable && row.checkAgain !== true ? null : (
                        <>
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
                                <a
                                  href={row.action.url}
                                  target="_blank"
                                  rel="noreferrer noopener"
                                />
                              }
                            >
                              {row.action.label}
                            </Button>
                          )}
                          {row.checkAgain === true ? (
                            <CheckAgain environmentId={props.environmentId} orgId={props.orgId} />
                          ) : null}
                        </>
                      )
                    }
                  />
                }
              />
              {picking === row.key ? (
                <div className="px-4 pb-3">
                  <AccountRepos
                    environmentId={props.environmentId}
                    orgId={props.orgId}
                    account={row.account}
                    settingsUrl={row.settingsUrl}
                  />
                </div>
              ) : null}
            </div>
          ))}
        </KinSettingsSection>
      )}
      {view.uses.length === 0 ? null : (
        <KinSettingsSection title={AGENTS.usesTitle}>
          {view.uses.map((use) => (
            <KinSettingsRow
              key={use.key}
              title={use.line}
              detail={<code className="font-mono">{use.command}</code>}
            />
          ))}
        </KinSettingsSection>
      )}
    </>
  );
}

export function KinGitHubInstantLine(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly agents: NonNullable<KinGitHubStatus["agents"]>;
  readonly now: number;
}) {
  const row = kinGitHubInstantRow(props.agents, props.now);
  if (row === null) return null;
  return (
    <KinSettingsRow
      title={<TitleWithStatus title={row.title} tone={row.tone} label={row.label} />}
      wrap
      detail={
        <DetailWithActions
          detail={row.detail}
          actions={
            row.action === null && row.offer !== true ? null : (
              <>
                {row.action === null ? null : (
                  <Button
                    size="xs"
                    variant="outline"
                    render={<a href={row.action.url} target="_blank" rel="noreferrer noopener" />}
                  >
                    {row.action.label}
                  </Button>
                )}
                {row.offer === true ? (
                  <AllowHook environmentId={props.environmentId} orgId={props.orgId} />
                ) : null}
              </>
            )
          }
        />
      }
    />
  );
}

/** Asks Kin to look at its App on GitHub now; every open screen redraws from what it sees. */
function CheckAgain(props: { readonly environmentId: EnvironmentId; readonly orgId: KinOrgId }) {
  const { environmentId, orgId } = props;
  const allowed = useAtomValue(kinClient.githubAppLook.permissionAtom(environmentId));
  const reload = useAtomRefresh(kinClient.github({ environmentId, input: { orgId } }));
  const look = useAtomCommand(kinClient.githubAppLook, { reportFailure: false });
  const actions = createKinGitHubLookActions({
    orgId,
    look: (input) => look({ environmentId, input }),
    refresh: reload,
  });
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  if (!allowed) return null;
  return (
    <>
      <Button
        size="xs"
        variant="outline"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setSaid(null);
          void actions.look().then((line) => {
            setBusy(false);
            setSaid(line);
          });
        }}
      >
        {AGENTS.checkAgain}
      </Button>
      {said === null ? null : <p className="w-full text-xs text-muted-foreground">{said}</p>}
    </>
  );
}

/** The owner's yes to Kin setting the webhook of an App it didn't make; the row then redraws. */
function AllowHook(props: { readonly environmentId: EnvironmentId; readonly orgId: KinOrgId }) {
  const { environmentId, orgId } = props;
  const allowed = useAtomValue(kinClient.githubAppHookAllow.permissionAtom(environmentId));
  const reload = useAtomRefresh(kinClient.github({ environmentId, input: { orgId } }));
  const allow = useAtomCommand(kinClient.githubAppHookAllow, { reportFailure: false });
  const actions = createKinGitHubHookActions({
    orgId,
    allow: (input) => allow({ environmentId, input }),
    refresh: reload,
  });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (!allowed) return null;
  return (
    <div className="flex shrink-0 flex-col gap-2">
      <Button
        size="xs"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setProblem(null);
          void actions.allow().then((outcome) => {
            setBusy(false);
            if (!outcome.ok) setProblem(outcome.problem);
          });
        }}
      >
        {INSTANT.allow}
      </Button>
      {problem === null ? null : (
        <Alert variant="error">
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

/** Makes or forgets Kin's own GitHub App: Create on GitHub, or Disconnect with a confirm. */
function AppSetUp(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly view: ReturnType<typeof kinGitHubAgentsView>;
  /** Install on more repos, beside the App's own buttons. */
  readonly install: ReactNode;
}) {
  const { environmentId, orgId, view } = props;
  const reload = useAtomRefresh(kinClient.github({ environmentId, input: { orgId } }));
  const create = useAtomCommand(kinClient.githubAppCreate, { reportFailure: false });
  const disconnect = useAtomCommand(kinClient.githubAppDisconnect, { reportFailure: false });
  const actions = createKinGitHubAppSetupActions({
    orgId,
    create: (input) => create({ environmentId, input }),
    disconnect: (input) => disconnect({ environmentId, input }),
    refresh: reload,
  });
  const [creating, setCreating] = useState<{
    readonly started: KinGitHubAppCreateStart | null;
    readonly problem: string | null;
  } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [left, setLeft] = useState<{ readonly name: string; readonly url: string | null } | null>(
    null,
  );
  const [problem, setProblem] = useState<string | null>(null);
  const forgetting = view.disconnect;
  return (
    <>
      <KinSettingsRow
        title={view.headline}
        wrap
        detail={
          <DetailWithActions
            detail={
              <>
                {view.detail}
                {view.setUpLine === null ? null : (
                  <span className="mt-1 block">{view.setUpLine}</span>
                )}
              </>
            }
            actions={
              view.canCreate || forgetting !== null || props.install !== null ? (
                <>
                  {view.canCreate ? (
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => {
                        setCreating({ started: null, problem: null });
                        void actions
                          .start()
                          .then((outcome) =>
                            setCreating((open) =>
                              open === null
                                ? null
                                : outcome.ok
                                  ? { started: outcome.value, problem: null }
                                  : { started: null, problem: outcome.problem },
                            ),
                          );
                      }}
                    >
                      {SETUP.create}
                    </Button>
                  ) : null}
                  {props.install}
                  {forgetting === null ? null : (
                    <Button size="xs" variant="outline" onClick={() => setConfirming(true)}>
                      {SETUP.disconnect}
                    </Button>
                  )}
                </>
              ) : null
            }
          />
        }
      />
      {left === null ? null : (
        <KinSettingsRow
          title={SETUP.disconnected(left.name)}
          wrap
          control={
            left.url === null ? null : (
              <Button
                size="xs"
                variant="outline"
                render={<a href={left.url} target="_blank" rel="noreferrer noopener" />}
              >
                {SETUP.appOnGitHub}
              </Button>
            )
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
      {creating === null ? null : (
        <CreateAppDialog
          started={creating.started}
          problem={creating.problem}
          onClose={() => setCreating(null)}
        />
      )}
      <KinConfirm
        ask={
          confirming && forgetting !== null
            ? {
                title: SETUP.disconnectTitle,
                detail: SETUP.disconnectDetail(forgetting.name),
                action: SETUP.disconnect,
                destructive: true,
              }
            : null
        }
        onConfirm={() => {
          setConfirming(false);
          setProblem(null);
          const name = forgetting?.name ?? "";
          void actions.disconnect().then((outcome) => {
            if (outcome.ok) setLeft({ name, url: outcome.value.settingsUrl });
            else setProblem(outcome.problem);
          });
        }}
        onClose={() => setConfirming(false)}
      />
    </>
  );
}

/** Names the App, then hands the owner's browser to GitHub through Kin's own page. */
function CreateAppDialog(props: {
  readonly started: KinGitHubAppCreateStart | null;
  readonly problem: string | null;
  readonly onClose: () => void;
}) {
  const { started, problem } = props;
  const [name, setName] = useState<string | null>(null);
  const nameId = useId();
  const shown = name ?? started?.name ?? "";
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : props.onClose())}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{SETUP.create}</DialogTitle>
          <DialogDescription>{SETUP.createDetail}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-2">
            {problem !== null ? (
              <Alert variant="error">
                <AlertDescription>{problem}</AlertDescription>
              </Alert>
            ) : started === null ? (
              <p className="text-sm text-muted-foreground">{SETUP.preparing}</p>
            ) : (
              <>
                <Label htmlFor={nameId}>{SETUP.nameLabel}</Label>
                <Input
                  id={nameId}
                  value={shown}
                  maxLength={34}
                  onChange={(event) => setName(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">{SETUP.nameHint}</p>
              </>
            )}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={props.onClose}>
            {COPY.cancel}
          </Button>
          {started === null ? null : (
            <Button
              render={
                <a
                  href={kinGitHubAppCreatePath(started, shown)}
                  target="_blank"
                  rel="noreferrer noopener"
                  onClick={props.onClose}
                />
              }
            >
              {SETUP.continue}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
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
      <div className="sm:basis-full">
        <KinSettingsLoading rows={2} />
      </div>
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
  const reloadRepos = useAtomRefresh(kinClient.githubRepos({ environmentId, input: { orgId } }));
  const reloadStatus = useAtomRefresh(kinClient.github({ environmentId, input: { orgId } }));
  const guard = useGuardActions(environmentId, orgId, () => {
    reloadRepos();
    reloadStatus();
  });
  const watch = status.watch;
  if (watch === undefined) return null;
  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <p className="text-sm text-muted-foreground">{kinGitHubWatchLine(watch, now)}</p>
      {watch.problem === null ? null : (
        <Alert variant="warning">
          <AlertDescription>{watch.problem}</AlertDescription>
        </Alert>
      )}
      {(watch.open ?? 0) > 0 ? (
        <ProtectAll
          environmentId={environmentId}
          orgId={orgId}
          open={watch.open ?? 0}
          guard={guard}
        />
      ) : null}
      <GuardOutcome outcome={guard.outcome} />
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

/** The protection's answer: how many worked, then each repo that didn't and why. */
function GuardOutcome(props: { readonly outcome: KinGitHubGuardOutcome | null }) {
  const { outcome } = props;
  if (outcome === null || (outcome.summary === null && outcome.problems.length === 0)) return null;
  return (
    <Alert variant={outcome.problems.length === 0 ? "success" : "error"}>
      <AlertDescription>
        {outcome.summary === null ? null : <p>{outcome.summary}</p>}
        {outcome.problems.length === 0 ? null : (
          <ul className="flex flex-col gap-1">
            {outcome.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        )}
      </AlertDescription>
    </Alert>
  );
}

function useGuardActions(environmentId: EnvironmentId, orgId: KinOrgId, refresh: () => void) {
  const set = useAtomCommand(kinClient.githubGuardSet, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<KinGitHubGuardOutcome | null>(null);
  const change = createKinGitHubGuardActions({
    orgId,
    set: (input) => set({ environmentId, input }),
    refresh,
  });
  const run = (repos: ReadonlyArray<string>, on: boolean, all = false) => {
    if (busy || repos.length === 0) return;
    setBusy(true);
    setOutcome(null);
    void change(repos, on, all).then((answer) => {
      setBusy(false);
      setOutcome(answer);
    });
  };
  return { busy, outcome, run };
}

/** "N watched repos have main branches that aren't closed to Kin's App", what protecting does, and Protect all. */
function ProtectAll(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly open: number;
  readonly guard: ReturnType<typeof useGuardActions>;
}) {
  const { environmentId, orgId, guard } = props;
  const reposAtom = kinClient.githubRepos({ environmentId, input: { orgId } });
  const repos = Option.getOrNull(AsyncResult.value(useAtomValue(reposAtom)))?.repos ?? null;
  const open = (repos ?? []).filter((repo) => kinGitHubGuardAction(repo.guard) === "protect");
  return (
    <div className="flex flex-col gap-2 rounded-md border px-3 py-2.5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-sm font-medium">{GUARD.open(props.open)}</p>
          <p className="text-xs text-muted-foreground">{GUARD.truth}</p>
        </div>
        <div className="shrink-0">
          <Button
            size="xs"
            variant="outline"
            disabled={guard.busy || open.length === 0}
            onClick={() =>
              guard.run(
                open.map((repo) => repo.repo),
                true,
                true,
              )
            }
          >
            {GUARD.protectAll}
          </Button>
        </div>
      </div>
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
  const reloadStatus = useAtomRefresh(kinClient.github({ environmentId, input: { orgId } }));
  const guard = useGuardActions(environmentId, orgId, () => {
    reload();
    reloadStatus();
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
      <KinSettingsLoading rows={3} />
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
                {repo.fork ? (
                  <KinSettingsStatus tone="quiet">{WATCH.fork}</KinSettingsStatus>
                ) : null}
              </div>
              {repo.mentions || repo.agentsAs !== undefined || kinGitHubGuardLine(repo) !== null ? (
                <span className="text-xs text-muted-foreground">
                  {[
                    repo.agentsAs === undefined
                      ? null
                      : repo.agentsAs === "app"
                        ? WATCH.asApp
                        : WATCH.asYou,
                    repo.mentions ? WATCH.mentions : null,
                    kinGitHubGuardLine(repo),
                  ]
                    .filter(Boolean)
                    .join(". ")}
                </span>
              ) : null}
              {kinGitHubGuardAction(repo.guard) === null ? null : (
                <div className="pt-1.5">
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={guard.busy}
                    onClick={() =>
                      guard.run([repo.repo], kinGitHubGuardAction(repo.guard) === "protect")
                    }
                  >
                    {kinGitHubGuardAction(repo.guard) === "protect" ? GUARD.protect : GUARD.remove}
                  </Button>
                </div>
              )}
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
      <GuardOutcome outcome={guard.outcome} />
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
