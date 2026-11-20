import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { KIN_CHECK_CONNECTION, KIN_RETRY } from "@t3tools/client-runtime/kin/kinAnswers";
import {
  createKinGitHubActions,
  createKinGitHubRepoActions,
  createKinGitHubAppRepoActions,
  createKinGitHubAppSetupActions,
  createKinGitHubGuardActions,
  KIN_GITHUB_APP_SETUP_COPY as SETUP,
  kinGitHubAppCreatePath,
  KIN_GITHUB_AGENTS_COPY as AGENTS,
  KIN_GITHUB_APP_REPOS_COPY as PICK,
  KIN_GITHUB_COPY as COPY,
  KIN_GITHUB_GUARD_COPY as GUARD,
  type KinGitHubGuardOutcome,
  KIN_GITHUB_WATCH_COPY as WATCH,
  kinGitHubAccountRepos,
  kinGitHubAccountRows,
  kinGitHubAccountsHint,
  kinGitHubAgentsView,
  kinGitHubGuardAction,
  kinGitHubGuardLine,
  kinGitHubRow,
  kinGitHubSheet,
  kinGitHubWatchLine,
} from "@t3tools/client-runtime/kin/kinGitHub";
import type {
  EnvironmentId,
  KinGitHubAgents,
  KinGitHubRepo,
  KinGitHubWatch,
  KinOrgId,
} from "@t3tools/contracts";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";
import { Linking, type TextInputInstance, View } from "react-native";

import { AppActivityIndicator } from "../../../components/ui/AppActivityIndicator";
import { AppBar } from "../../../components/ui/AppBar";
import { AppText as Text } from "../../../components/ui/AppText";
import * as Dialog from "../../../components/ui/Dialog";
import { ErrorBanner } from "../../../components/ui/ErrorBanner";
import { ListActionRow } from "../../../components/ui/ListActionRow";
import { ListRow } from "../../../components/ui/ListRow";
import { ListRowLayout } from "../../../components/ui/ListRowLayout";
import { ListSection } from "../../../components/ui/ListSection";
import { ListToggleRow } from "../../../components/ui/ListToggleRow";
import { Notice } from "../../../components/ui/Notice";
import { ScreenContent } from "../../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../../components/ui/ScreenScrollView";
import { SearchField } from "../../../components/ui/SearchField";
import { SecretTextInput } from "../../../components/ui/SecretTextInput";
import { useNowMinuteMs } from "../../../lib/clock";
import { tryCopyTextWithHaptic } from "../../../lib/copyTextWithHaptic";
import { usePreparedConnection } from "../../../state/session";
import { useAtomCommand } from "../../../state/use-atom-command";
import { kinClient } from "../state/kinClient";
import {
  decodeConnectionsTarget,
  KinConnectionsMissing,
  type KinConnectionsParams,
  type KinConnectionsTarget,
} from "./kinConnectionTarget";

function useGitHub(environmentId: EnvironmentId, orgId: KinOrgId) {
  const statusAtom = kinClient.github({ environmentId, input: { orgId } });
  const result = useAtomValue(statusAtom);
  const reload = useAtomRefresh(statusAtom);
  const start = useAtomCommand(kinClient.githubStart, { reportFailure: false });
  const cancel = useAtomCommand(kinClient.githubCancel, { reportFailure: false });
  const disconnect = useAtomCommand(kinClient.githubDisconnect, { reportFailure: false });
  return {
    result,
    reload,
    status: Option.getOrNull(AsyncResult.value(result)),
    actions: createKinGitHubActions({
      orgId,
      start: (input) => start({ environmentId, input }),
      cancel: (input) => cancel({ environmentId, input }),
      disconnect: (input) => disconnect({ environmentId, input }),
      refresh: reload,
    }),
  };
}

/** The GitHub section of Settings → Connections; only owners and co-owners reach that screen. */
export function KinGitHubSection(props: {
  readonly params: KinConnectionsParams;
  readonly target: KinConnectionsTarget;
}) {
  const navigation = useNavigation();
  const { result, reload, status, actions } = useGitHub(
    props.target.environmentId,
    props.target.orgId,
  );
  const [problem, setProblem] = useState<string | null>(null);
  if (status === null)
    return AsyncResult.isFailure(result) ? (
      <Notice
        tone="danger"
        message={COPY.loadFailed}
        action={{ label: KIN_RETRY, onPress: reload }}
      />
    ) : null;
  const row = kinGitHubRow(status);
  const login = status.account?.login ?? null;
  const confirmDisconnect = () => {
    if (login === null) return;
    Dialog.alert(COPY.disconnectTitle, COPY.disconnectDetail(login), [
      { text: COPY.cancel, style: "cancel" },
      {
        text: COPY.disconnect,
        style: "destructive",
        onPress: () =>
          void actions.disconnect().then((outcome) => {
            setProblem(outcome.ok ? null : outcome.problem);
          }),
      },
    ]);
  };
  return (
    <View className="gap-2">
      {problem === null ? null : <ErrorBanner message={problem} />}
      <ListSection title={COPY.title} footer={row.action === "connect" ? row.detail : COPY.intro}>
        <ListRow
          icon={
            row.tone === "error"
              ? "exclamationmark.triangle"
              : row.tone === "ok"
                ? "checkmark.circle"
                : "link"
          }
          label={row.title}
          description={row.action === "connect" ? undefined : row.detail}
          detail={row.label}
          onPress={() =>
            row.action === "disconnect"
              ? confirmDisconnect()
              : navigation.navigate("KinGitHubConnect", props.params)
          }
        />
        {row.action === "connect" || row.action === "reconnect" || row.action === "waiting" ? (
          <ListActionRow
            label={
              row.action === "reconnect"
                ? COPY.reconnect
                : row.action === "waiting"
                  ? COPY.enterCode
                  : COPY.connect
            }
            onPress={() => navigation.navigate("KinGitHubConnect", props.params)}
          />
        ) : null}
        {login === null ? null : (
          <ListActionRow label={COPY.disconnect} tone="danger" onPress={confirmDisconnect} />
        )}
      </ListSection>
      {status.account?.problem === null && status.watch !== undefined ? (
        <WatchedRepos target={props.target} watch={status.watch} />
      ) : null}
      {status.agents === undefined ? null : (
        <AgentIdentity agents={status.agents} login={login} target={props.target} />
      )}
    </View>
  );
}

/** Who agents work as on GitHub, where the App is missing, and what they lately did as the owner. */
function AgentIdentity(props: {
  readonly agents: KinGitHubAgents;
  readonly login: string | null;
  readonly target: KinConnectionsTarget;
}) {
  const view = kinGitHubAgentsView(props.agents, props.login, useNowMinuteMs());
  const installUrl = view.installUrl;
  const rows = kinGitHubAccountRows(props.agents);
  const hint = kinGitHubAccountsHint(rows);
  const [picking, setPicking] = useState<string | null>(null);
  return (
    <>
      <ListSection title={AGENTS.title} footer={view.detail}>
        <ListRowLayout label={view.headline} />
        <AppSetUp target={props.target} view={view} />
        {installUrl === null ? null : (
          <View className="border-t border-border-subtle">
            <ListActionRow
              label={AGENTS.install}
              onPress={() => void Linking.openURL(installUrl)}
            />
          </View>
        )}
      </ListSection>
      {rows.length === 0 ? null : (
        <ListSection title={AGENTS.accountsTitle} {...(hint === null ? {} : { footer: hint })}>
          {rows.map((row, index) => {
            const action = row.action;
            return (
              <View
                key={row.key}
                className={index === 0 ? undefined : "border-t border-border-subtle"}
              >
                <ListRowLayout label={row.account} detail={row.label} description={row.detail} />
                {row.pickable ? (
                  <ListActionRow
                    label={picking === row.key ? PICK.hide : PICK.choose(row.watched)}
                    onPress={() => setPicking(picking === row.key ? null : row.key)}
                  />
                ) : null}
                {action === null ? null : (
                  <ListActionRow
                    label={action.label}
                    onPress={() => void Linking.openURL(action.url)}
                  />
                )}
                {picking === row.key ? (
                  <AccountRepos
                    target={props.target}
                    account={row.account}
                    settingsUrl={row.settingsUrl}
                  />
                ) : null}
              </View>
            );
          })}
        </ListSection>
      )}
      {view.uses.length === 0 ? null : (
        <ListSection title={AGENTS.usesTitle}>
          {view.uses.map((use, index) => (
            <View
              key={use.key}
              className={index === 0 ? undefined : "border-t border-border-subtle"}
            >
              <ListRowLayout label={use.command} description={use.line} />
            </View>
          ))}
        </ListSection>
      )}
    </>
  );
}

/** Makes Kin's own GitHub App on GitHub, or forgets the one made here. */
function AppSetUp(props: {
  readonly target: KinConnectionsTarget;
  readonly view: ReturnType<typeof kinGitHubAgentsView>;
}) {
  const { environmentId, orgId } = props.target;
  const { view } = props;
  const reload = useAtomRefresh(kinClient.github({ environmentId, input: { orgId } }));
  const create = useAtomCommand(kinClient.githubAppCreate, { reportFailure: false });
  const disconnect = useAtomCommand(kinClient.githubAppDisconnect, { reportFailure: false });
  const connection = usePreparedConnection(environmentId);
  const [problem, setProblem] = useState<string | null>(null);
  const actions = createKinGitHubAppSetupActions({
    orgId,
    create: (input) => create({ environmentId, input }),
    disconnect: (input) => disconnect({ environmentId, input }),
    refresh: reload,
  });
  const forgetting = view.disconnect;
  const startCreate = async () => {
    setProblem(null);
    const outcome = await actions.start();
    if (!outcome.ok) return setProblem(outcome.problem);
    const started = outcome.value;
    Dialog.prompt({
      title: SETUP.create,
      message: `${SETUP.createDetail}\n\n${SETUP.nameHint}`,
      initialValue: started.name,
      confirmText: SETUP.continue,
      onConfirm: (name) => {
        const url = Option.isSome(connection)
          ? resolveAssetUrl(connection.value.httpBaseUrl, kinGitHubAppCreatePath(started, name))
          : null;
        if (url === null) setProblem(KIN_CHECK_CONNECTION);
        else void Linking.openURL(url);
      },
    });
  };
  const confirmDisconnect = (name: string) =>
    Dialog.confirm({
      title: SETUP.disconnectTitle,
      message: SETUP.disconnectDetail(name),
      confirmText: SETUP.disconnect,
      destructive: true,
      onConfirm: () =>
        void actions.disconnect().then((outcome) => {
          if (!outcome.ok) return setProblem(outcome.problem);
          const url = outcome.value.settingsUrl;
          Dialog.alert(SETUP.disconnect, SETUP.disconnected(name), [
            { text: COPY.done, style: "cancel" },
            ...(url === null
              ? []
              : [{ text: SETUP.appOnGitHub, onPress: () => void Linking.openURL(url) }]),
          ]);
        }),
    });
  return (
    <>
      {view.setUpLine === null ? null : (
        <View className="border-t border-border-subtle">
          <ListRowLayout label={view.setUpLine} />
        </View>
      )}
      {problem === null ? null : (
        <View className="border-t border-border-subtle px-3 py-2">
          <ErrorBanner message={problem} />
        </View>
      )}
      {view.canCreate ? (
        <View className="border-t border-border-subtle">
          <ListActionRow label={SETUP.create} onPress={() => void startCreate()} />
        </View>
      ) : null}
      {forgetting === null ? null : (
        <View className="border-t border-border-subtle">
          <ListActionRow
            label={SETUP.disconnect}
            tone="danger"
            onPress={() => confirmDisconnect(forgetting.name)}
          />
        </View>
      )}
    </>
  );
}

/** What Kin watches with the login: one line, why a look failed, and a switch per repo. */
function WatchedRepos(props: {
  readonly target: KinConnectionsTarget;
  readonly watch: KinGitHubWatch;
}) {
  const { target, watch } = props;
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const guard = useGuardActions(target);
  const line = kinGitHubWatchLine(watch, useNowMinuteMs());
  return (
    <>
      {watch.problem === null ? null : <Notice tone="danger" message={watch.problem} />}
      {problem === null ? null : <ErrorBanner message={problem} />}
      {guard.notice}
      {(watch.open ?? 0) > 0 ? (
        <ProtectAll target={target} open={watch.open ?? 0} guard={guard} />
      ) : null}
      <ListSection title={WATCH.reposTitle} footer={open ? `${line}\n\n${WATCH.reposHint}` : line}>
        {open ? <RepoRows target={target} onProblem={setProblem} /> : null}
        <ListActionRow
          label={open ? WATCH.hideRepos : WATCH.showRepos(watch.repos)}
          onPress={() => setOpen(!open)}
        />
      </ListSection>
    </>
  );
}

/** One account's watched repos, each with a switch that puts the App on it or takes it off. */
function AccountRepos(props: {
  readonly target: KinConnectionsTarget;
  readonly account: string;
  readonly settingsUrl: string | null;
}) {
  const { environmentId, orgId } = props.target;
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
  const searchRef = useRef<TextInputInstance | null>(null);
  const all = Option.getOrNull(AsyncResult.value(result))?.repos ?? null;
  if (all === null)
    return AsyncResult.isFailure(result) ? (
      <ListActionRow label={KIN_RETRY} description={WATCH.loadFailed} onPress={reload} />
    ) : (
      <View className="items-center py-3">
        <AppActivityIndicator />
      </View>
    );
  const mine = kinGitHubAccountRepos(all, props.account, "");
  const shown = kinGitHubAccountRepos(all, props.account, query);
  const on = mine.filter((repo) => repo.agentsAs === "app").map((repo) => repo.repo);
  const off = mine.filter((repo) => repo.agentsAs !== "app").map((repo) => repo.repo);
  const run = (repos: ReadonlyArray<string>, putOn: boolean) => {
    if (busy || repos.length === 0) return;
    setBusy(true);
    setProblem(null);
    void change(props.account, repos, putOn).then((outcome) => {
      setBusy(false);
      setProblem(outcome.problem);
    });
  };
  const settingsUrl = props.settingsUrl;
  return (
    <View className="border-t border-border-subtle">
      <View className="px-4 py-3">
        <Text className="text-sm text-foreground-muted">{PICK.hint}</Text>
      </View>
      {mine.length > 8 ? (
        <View className="px-4 pb-3">
          <SearchField
            autoFocus={false}
            inputRef={searchRef}
            accessibilityLabel={PICK.search}
            clearAccessibilityLabel="Clear"
            placeholder={PICK.search}
            value={query}
            onChangeText={setQuery}
          />
        </View>
      ) : null}
      {off.length === 0 ? null : (
        <ListActionRow label={PICK.addAll} onPress={() => run(off, true)} />
      )}
      {on.length === 0 ? null : (
        <ListActionRow label={PICK.removeAll} tone="danger" onPress={() => run(on, false)} />
      )}
      {shown.length === 0 ? (
        <View className="px-4 py-3">
          <Text className="text-foreground-muted">{PICK.none}</Text>
        </View>
      ) : (
        shown.map((repo) => (
          <ListToggleRow
            key={repo.repo}
            label={repo.repo}
            description={repo.agentsAs === "app" ? WATCH.asApp : WATCH.asYou}
            disabled={busy}
            value={repo.agentsAs === "app"}
            onValueChange={(value) => run([repo.repo], value)}
          />
        ))
      )}
      {problem === null ? null : <ErrorBanner message={problem} />}
      {problem === null || settingsUrl === null ? null : (
        <ListActionRow
          label={PICK.openOnGitHub}
          onPress={() => void Linking.openURL(settingsUrl)}
        />
      )}
    </View>
  );
}

function useGuardActions(target: KinConnectionsTarget) {
  const { environmentId, orgId } = target;
  const reload = useAtomRefresh(kinClient.githubRepos({ environmentId, input: { orgId } }));
  const reloadStatus = useAtomRefresh(kinClient.github({ environmentId, input: { orgId } }));
  const set = useAtomCommand(kinClient.githubGuardSet, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<KinGitHubGuardOutcome | null>(null);
  const change = createKinGitHubGuardActions({
    orgId,
    set: (input) => set({ environmentId, input }),
    refresh: () => {
      reload();
      reloadStatus();
    },
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
  const notice =
    outcome === null || (outcome.summary === null && outcome.problems.length === 0) ? null : (
      <Notice
        tone={outcome.problems.length === 0 ? "default" : "danger"}
        message={[outcome.summary, ...outcome.problems].filter(Boolean).join("\n")}
      />
    );
  return { busy, run, notice };
}

/** "N watched repos have main branches that aren't closed to Kin's App", what protecting does, and Protect all. */
function ProtectAll(props: {
  readonly target: KinConnectionsTarget;
  readonly open: number;
  readonly guard: ReturnType<typeof useGuardActions>;
}) {
  const { environmentId, orgId } = props.target;
  const { guard } = props;
  const repos =
    Option.getOrNull(
      AsyncResult.value(useAtomValue(kinClient.githubRepos({ environmentId, input: { orgId } }))),
    )?.repos ?? [];
  const open = repos.filter((repo) => kinGitHubGuardAction(repo.guard) === "protect");
  return (
    <>
      <ListSection footer={GUARD.truth}>
        <ListActionRow
          label={GUARD.protectAll}
          description={GUARD.open(props.open)}
          loading={guard.busy}
          disabled={open.length === 0}
          onPress={() =>
            guard.run(
              open.map((repo) => repo.repo),
              true,
              true,
            )
          }
        />
      </ListSection>
    </>
  );
}

/** "Fork · Your @-mention calls an agent", or nothing. */
function repoNote(repo: KinGitHubRepo): string | undefined {
  const parts: Array<string> = [];
  if (repo.agentsAs !== undefined) parts.push(repo.agentsAs === "app" ? WATCH.asApp : WATCH.asYou);
  if (repo.fork) parts.push(WATCH.fork);
  if (repo.mentions) parts.push(WATCH.mentions);
  const guard = kinGitHubGuardLine(repo);
  if (guard !== null) parts.push(guard);
  return parts.length === 0 ? undefined : parts.join(" · ");
}

function RepoRows(props: {
  readonly target: KinConnectionsTarget;
  readonly onProblem: (problem: string | null) => void;
}) {
  const { environmentId, orgId } = props.target;
  const reposAtom = kinClient.githubRepos({ environmentId, input: { orgId } });
  const result = useAtomValue(reposAtom);
  const reload = useAtomRefresh(reposAtom);
  const set = useAtomCommand(kinClient.githubReposSet, { reportFailure: false });
  const actions = createKinGitHubRepoActions({
    orgId,
    set: (input) => set({ environmentId, input }),
    refresh: reload,
  });
  const settle = (outcome: Awaited<ReturnType<typeof actions.everything>>) =>
    props.onProblem(outcome.ok ? null : outcome.problem);
  const guard = useGuardActions(props.target);
  const repos = Option.getOrNull(AsyncResult.value(result))?.repos ?? null;
  if (repos === null)
    return AsyncResult.isFailure(result) ? (
      <ListActionRow label={KIN_RETRY} description={WATCH.loadFailed} onPress={reload} />
    ) : (
      <View className="items-center py-3">
        <AppActivityIndicator />
      </View>
    );
  return (
    <>
      {repos.length === 0 ? (
        <View className="px-4 py-3">
          <Text className="text-foreground-muted">{WATCH.noRepos}</Text>
        </View>
      ) : null}
      {guard.notice}
      {repos.map((repo) => {
        const action = kinGitHubGuardAction(repo.guard);
        return (
          <View key={repo.repo}>
            <ListToggleRow
              label={repo.repo}
              description={repoNote(repo)}
              value={repo.watched}
              onValueChange={(watched) => void actions.watch(repo, watched).then(settle)}
            />
            {action === null ? null : (
              <ListActionRow
                label={action === "protect" ? GUARD.protect : GUARD.remove}
                description={repo.repo}
                disabled={guard.busy}
                onPress={() => guard.run([repo.repo], action === "protect")}
              />
            )}
          </View>
        );
      })}
      {repos.some((repo) => !repo.watched && !repo.fork) ? (
        <ListActionRow
          label={WATCH.watchEverything}
          onPress={() => void actions.everything().then(settle)}
        />
      ) : null}
    </>
  );
}

/** The Connect sheet: get a code and enter it on GitHub, or paste a token. Updates live. */
export function KinGitHubConnectScreen({ route }: StaticScreenProps<KinConnectionsParams>) {
  const target = decodeConnectionsTarget(route.params);
  return target === null ? (
    <KinConnectionsMissing title={COPY.sheetTitle} sheet />
  ) : (
    <ConnectSheet target={target} />
  );
}

function ConnectSheet(props: { readonly target: KinConnectionsTarget }) {
  const navigation = useNavigation();
  const { result, status, actions } = useGitHub(props.target.environmentId, props.target.orgId);
  const step = kinGitHubSheet(status);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [withToken, setWithToken] = useState(false);
  const [token, setToken] = useState("");

  const submit = async (typed?: string) => {
    if (busy || step.step !== "start") return;
    setBusy(true);
    setProblem(null);
    const outcome = withToken
      ? await actions.connectWithToken(typed ?? token)
      : await actions.getCode();
    setBusy(false);
    if (!outcome.ok) setProblem(outcome.problem);
    else setToken("");
  };
  const close = () => {
    if (step.step === "code") void actions.cancel();
    navigation.goBack();
  };

  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar
        title={COPY.sheetTitle}
        onClose={close}
        {...(step.step === "start"
          ? {
              confirm: {
                label: busy
                  ? withToken
                    ? COPY.connecting
                    : COPY.gettingCode
                  : withToken
                    ? COPY.connect
                    : COPY.getCode,
                onPress: () => void submit(),
                loading: busy,
                disabled: busy || status === null,
              },
            }
          : step.step === "done"
            ? { confirm: { label: COPY.done, onPress: () => navigation.goBack() } }
            : {})}
      />
      <ScreenContent surface="screen">
        <ScreenScrollView
          className="flex-1"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 20 }}
        >
          {status === null ? (
            AsyncResult.isFailure(result) ? (
              <ErrorBanner message={COPY.loadFailed} />
            ) : (
              <AppActivityIndicator />
            )
          ) : (
            <>
              <Text textRole="body" className="px-2 text-foreground-muted">
                {COPY.intro}
              </Text>
              {problem === null ? null : <ErrorBanner message={problem} />}
              {step.step === "start" && step.failed !== null && problem === null ? (
                <ErrorBanner message={step.failed} />
              ) : null}
              {step.step === "code" ? (
                <>
                  <ListSection title={COPY.enterCode} footer={COPY.codeHint}>
                    <View className="items-center px-4 py-5">
                      <Text
                        selectable
                        accessibilityLabel={`Code ${step.code.split("").join(" ")}`}
                        className="font-mono text-3xl font-semibold tracking-widest text-foreground"
                      >
                        {step.code}
                      </Text>
                    </View>
                    <ListActionRow
                      label={COPY.copy}
                      onPress={() => void tryCopyTextWithHaptic(step.code, { target: "code" })}
                    />
                    <ListActionRow
                      label={COPY.openGitHub}
                      onPress={() => void Linking.openURL(step.url)}
                    />
                  </ListSection>
                  <View className="flex-row items-center justify-center gap-2">
                    <AppActivityIndicator />
                    <Text textRole="footnote" className="text-foreground-muted">
                      {COPY.waiting}
                    </Text>
                  </View>
                </>
              ) : step.step === "done" ? (
                <Notice icon="checkmark.circle" message={step.detail} />
              ) : (
                <>
                  {withToken ? (
                    <View className="gap-2">
                      <ListSection>
                        <View className="gap-2 px-4 py-3">
                          <Text className="text-sm text-foreground-muted">{COPY.tokenLabel}</Text>
                          <SecretTextInput
                            accessibilityLabel={COPY.tokenLabel}
                            placeholder={COPY.tokenPlaceholder}
                            value={token}
                            editable={!busy}
                            onChangeText={setToken}
                            onSubmitEditing={(typed) => void submit(typed)}
                          />
                        </View>
                      </ListSection>
                      <Text textRole="footnote" className="px-4 text-foreground-muted">
                        {COPY.tokenHint}
                      </Text>
                    </View>
                  ) : null}
                  <ListSection>
                    <ListActionRow
                      label={withToken ? COPY.codeInstead : COPY.tokenInstead}
                      disabled={busy}
                      onPress={() => {
                        setProblem(null);
                        setWithToken(!withToken);
                      }}
                    />
                  </ListSection>
                </>
              )}
            </>
          )}
        </ScreenScrollView>
      </ScreenContent>
    </View>
  );
}
