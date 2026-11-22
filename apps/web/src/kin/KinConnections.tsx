import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  KIN_CONNECTIONS_COPY as COPY,
  KIN_MAIL_COPY as MAIL,
  KIN_MAIL_PERMISSIONS,
  createKinConnectionActions,
  KIN_OWNER_CLIENT_SETUP,
  kinAddableServices,
  kinConnectionDraft,
  kinConnectionProvider,
  kinConnectionStatus,
  kinIsMailConnection,
  kinIsOwnerClientService,
  kinMailModes,
  kinMailPermission,
  kinServiceNote,
  type KinConnectionDraft,
  type KinConnectionStatus,
  type KinMailPermission,
} from "@t3tools/client-runtime/kin/kinConnections";
import { KIN_SETTINGS_COPY } from "@t3tools/client-runtime/kin/kinSettingsSpread";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  KinConnection,
  KinConnectionDetail,
  KinConnectionId,
  KinConnectionService,
  KinConnectionsView,
  KinConnectionToolMode,
  KinOrgId,
} from "@t3tools/contracts";
import { useLocation } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { PlusIcon } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { useSearchableSetting } from "../components/settings/settingsSearch";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { useAtomCommand } from "../state/use-atom-command";
import { KinConnectionPage, type KinMailDiffers } from "./KinConnectionPage";
import { OwnerClientSetup, openSignInWindow, SignInWaiting } from "./KinConnectionSignIn";
import { KinGitHubConnect, KinGitHubPage } from "./KinGitHubConnect";
import { KinMyMailbox, KinPeopleMailboxes } from "./KinMyMailbox";
import { kinNewLeadTarget } from "./KinNewLeadButton";
import { KinSocialConnect } from "./KinSocialConnect";
import { KinVisualHosts } from "./KinVisualHosts";
import { kinClient } from "./kinClient";
import { kinSettingsFindIn } from "./kinSettingsAddress";
import { KinSettingsChoice, useKinSettingsSave } from "./settings/KinSettingsControls";
import {
  KinSettingsEmpty,
  KinSettingsLoadFailed,
  KinSettingsLoading,
  KinSettingsPage,
  KinSettingsRow,
  KinSettingsSection,
  KinSettingsStatus,
} from "./settings/KinSettingsLayout";
import { KinSettingsSubpage } from "./settings/KinSettingsSubpage";
import { useKinHost } from "./useKinHost";

type Target = { readonly environmentId: EnvironmentId; readonly orgId: KinOrgId };
/** The drill-in that replaces the list: one connection's page, or GitHub's. */
type Open = { readonly kind: "connection"; readonly id: string } | { readonly kind: "github" };
type Adding = { readonly title: string; readonly offered: ReadonlyArray<KinConnectionService> };

const isMailService = (service: KinConnectionService) =>
  service.service === "google" || service.service === "microsoft";

/** Settings → Connections: mail and calendar, GitHub, social, other services, then charts. */
export function KinConnectionsSettings() {
  const target = kinNewLeadTarget(useKinHost());
  return target === null ? (
    <KinSettingsPage>
      <KinSettingsSection>
        <KinSettingsEmpty>{COPY.noKin}</KinSettingsEmpty>
      </KinSettingsSection>
    </KinSettingsPage>
  ) : (
    <Connections environmentId={target.environmentId} orgId={target.orgId} />
  );
}

function Connections(props: Target) {
  const { environmentId, orgId } = props;
  const listAtom = kinClient.connections({ environmentId, input: { orgId } });
  const result = useAtomValue(listAtom);
  const view = Option.getOrNull(AsyncResult.value(result));
  const accounts = (view?.connections ?? []).filter(kinIsMailConnection);
  return (
    <EachDetail
      environmentId={environmentId}
      orgId={orgId}
      ids={accounts.map((account) => account.connectionId)}
      got={[]}
    >
      {(details) => (
        <ConnectionsBody
          {...props}
          view={view}
          failed={AsyncResult.isFailure(result)}
          details={details}
        />
      )}
    </EachDetail>
  );
}

/**
 * Reads every mail account's tools, one hook per account, so the three rows said once can count
 * them. Each level reads one account and hands the rest down.
 */
function EachDetail(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly ids: ReadonlyArray<KinConnectionId>;
  readonly got: ReadonlyArray<KinConnectionDetail | null>;
  readonly children: (details: ReadonlyArray<KinConnectionDetail | null>) => ReactNode;
}) {
  const [first, ...rest] = props.ids;
  return first === undefined ? (
    props.children(props.got)
  ) : (
    <OneDetail {...props} id={first} rest={rest} />
  );
}

function OneDetail(
  props: Parameters<typeof EachDetail>[0] & {
    readonly id: KinConnectionId;
    readonly rest: ReadonlyArray<KinConnectionId>;
  },
) {
  const detail = Option.getOrNull(
    AsyncResult.value(
      useAtomValue(
        kinClient.connection({
          environmentId: props.environmentId,
          input: { orgId: props.orgId, connectionId: props.id },
        }),
      ),
    ),
  );
  return (
    <EachDetail
      environmentId={props.environmentId}
      orgId={props.orgId}
      ids={props.rest}
      got={[...props.got, detail]}
    >
      {props.children}
    </EachDetail>
  );
}

/** A row's state, said only when it isn't fine: problems are badges, Paused is quiet. */
function rowStatus(status: KinConnectionStatus) {
  if (status.tone === "ok") return null;
  return (
    <KinSettingsStatus tone={status.tone === "muted" ? "quiet" : status.tone}>
      {status.label}
    </KinSettingsStatus>
  );
}

const needsLook = (connection: KinConnection) => {
  const tone = kinConnectionStatus(connection).tone;
  return tone === "error" || tone === "attention" ? 0 : 1;
};

function ConnectionsBody(
  props: Target & {
    readonly view: KinConnectionsView | null;
    readonly failed: boolean;
    readonly details: ReadonlyArray<KinConnectionDetail | null>;
  },
) {
  const searchableSetting = useSearchableSetting();
  const { environmentId, orgId, view, details } = props;
  const reload = useAtomRefresh(kinClient.connections({ environmentId, input: { orgId } }));
  // A link into Settings can name the connection to open at, as a done suggestion does.
  const named = useLocation({ select: (location) => kinSettingsFindIn(location.searchStr) });
  const [open, setOpen] = useState<Open | null>(
    named === "" ? null : { kind: "connection", id: named },
  );
  const [adding, setAdding] = useState<Adding | null>(null);
  const add = useAtomCommand(kinClient.connectionAdd, { reportFailure: false });
  const remove = useAtomCommand(kinClient.connectionRemove, { reportFailure: false });
  const signInStart = useAtomCommand(kinClient.connectionSignInStart, { reportFailure: false });
  const signInFinish = useAtomCommand(kinClient.connectionSignInFinish, { reportFailure: false });
  const setSignInClient = useAtomCommand(kinClient.connectionSetSignInClient, {
    reportFailure: false,
  });
  const setModes = useAtomCommand(kinClient.connectionSetToolModes, { reportFailure: false });
  const save = useKinSettingsSave();
  const actions = createKinConnectionActions({
    orgId,
    add: (input) => add({ environmentId, input }),
    remove: (input) => remove({ environmentId, input }),
    signInStart: (input) => signInStart({ environmentId, input }),
    signInFinish: (input) => signInFinish({ environmentId, input }),
    setSignInClient: (input) => setSignInClient({ environmentId, input }),
    refresh: reload,
  });
  const connections = view?.connections ?? [];
  const accounts = connections.filter(kinIsMailConnection);
  const others = connections.filter((connection) => !kinIsMailConnection(connection));
  const loaded = details.every((detail) => detail !== null);
  const toolsOf = details.flatMap((detail) => (detail === null ? [] : [detail.tools]));
  const said = KIN_MAIL_PERMISSIONS.map((one) => ({
    ...one,
    row: loaded ? kinMailPermission(toolsOf, one.permission) : null,
  }));
  const differs: KinMailDiffers = (permission, tools) =>
    said.find((one) => one.permission === permission)?.row?.differs(tools) ?? false;
  const services = view?.services ?? [];
  const mailServices = kinAddableServices(services.filter(isMailService));
  const otherServices = services.filter((service) => !isMailService(service));

  const setAll = (permission: KinMailPermission, mode: KinConnectionToolMode) =>
    void save.run(`all:${permission}`, MAIL.allFailed, async () => {
      let last: AtomCommandResult<unknown, unknown> = AsyncResult.success(null);
      for (const detail of details) {
        if (detail === null) continue;
        const modes = kinMailModes(detail.tools, permission, mode);
        if (modes.length === 0) continue;
        last = await setModes({
          environmentId,
          input: { orgId, connectionId: detail.connection.connectionId, modes },
        });
        if (!AsyncResult.isSuccess(last)) return last;
      }
      return last;
    });

  const opened =
    open?.kind === "connection"
      ? (connections.find((connection) => connection.connectionId === open.id) ?? null)
      : null;
  if (opened !== null) {
    const address = opened.accountLabel ?? opened.label;
    return (
      <KinSettingsSubpage title={address} backTo={COPY.title} onBack={() => setOpen(null)}>
        <KinConnectionPage
          environmentId={environmentId}
          orgId={orgId}
          connection={opened}
          actions={actions}
          signInAddress={view?.signInAddress ?? ""}
          differs={differs}
          onRemoved={() => setOpen(null)}
        />
      </KinSettingsSubpage>
    );
  }
  if (open?.kind === "github")
    return (
      <KinSettingsSubpage title={COPY.github} backTo={COPY.title} onBack={() => setOpen(null)}>
        <KinGitHubPage environmentId={environmentId} orgId={orgId} />
      </KinSettingsSubpage>
    );

  const openRow = (connection: KinConnection, title: string, detail: string | undefined) => (
    <KinSettingsRow
      key={connection.connectionId}
      title={title}
      detail={detail}
      status={rowStatus(kinConnectionStatus(connection))}
      openLabel={`${MAIL.open}: ${title}`}
      onOpen={() => setOpen({ kind: "connection", id: connection.connectionId })}
    />
  );
  // Accounts by provider; a provider with an account that needs you comes first.
  const byProvider = (["google", "microsoft"] as const)
    .flatMap((preset) => {
      const list = accounts
        .filter((account) => account.preset === preset)
        .toSorted(
          (a, b) =>
            needsLook(a) - needsLook(b) ||
            (a.accountLabel ?? a.label).localeCompare(b.accountLabel ?? b.label),
        );
      return list.length === 0 ? [] : [{ preset, list, fine: Math.min(...list.map(needsLook)) }];
    })
    .toSorted((a, b) => a.fine - b.fine);

  return (
    <KinSettingsPage purpose={COPY.purpose}>
      <div className="flex flex-col gap-5">
        <KinMyMailbox environmentId={environmentId} orgId={orgId} />
        <KinPeopleMailboxes
          environmentId={environmentId}
          orgId={orgId}
          mailboxes={view?.mailboxes ?? []}
        />
        <KinSettingsSection
          title={MAIL.section}
          description={accounts.length === 0 ? undefined : MAIL.sectionDetail}
          searchId={searchableSetting("kin-connections").id}
          problem={save.problem}
          action={
            mailServices.length === 0 ? undefined : (
              <Menu>
                <MenuTrigger render={<Button size="xs" variant="outline" />}>
                  <PlusIcon />
                  {MAIL.add}
                </MenuTrigger>
                <MenuPopup align="end">
                  {mailServices.map((service) => (
                    <MenuItem
                      key={service.service}
                      disabled={!service.available}
                      onClick={() =>
                        setAdding({ title: MAIL.addTitle(service.label), offered: [service] })
                      }
                    >
                      {service.available ? service.label : `${service.label} · ${COPY.soon}`}
                    </MenuItem>
                  ))}
                </MenuPopup>
              </Menu>
            )
          }
        >
          {view === null ? (
            props.failed ? (
              <KinSettingsLoadFailed onRetry={reload}>{MAIL.loadFailed}</KinSettingsLoadFailed>
            ) : (
              <KinSettingsLoading rows={3} />
            )
          ) : accounts.length === 0 ? (
            <KinSettingsEmpty>{MAIL.empty}</KinSettingsEmpty>
          ) : !loaded ? (
            <KinSettingsLoading rows={3} />
          ) : (
            said.map((one) =>
              one.row === null ? null : (
                <KinSettingsRow
                  key={one.permission}
                  wrap
                  title={one.title}
                  control={
                    <KinSettingsChoice
                      label={`${one.title}, every account`}
                      value={one.row.value}
                      options={one.options}
                      disabled={save.busy !== null}
                      onChange={(mode) => setAll(one.permission, mode)}
                    />
                  }
                />
              ),
            )
          )}
        </KinSettingsSection>
        {byProvider.map(({ preset, list }) => (
          <KinSettingsSection key={preset} title={MAIL.providerAccounts(preset)}>
            {list.map((account) => {
              const address = account.accountLabel ?? account.label;
              const label =
                account.label === address || account.label === kinConnectionProvider(account)
                  ? undefined
                  : account.label;
              return openRow(account, address, label);
            })}
          </KinSettingsSection>
        ))}
      </div>
      <KinGitHubConnect
        environmentId={environmentId}
        orgId={orgId}
        onOpen={() => setOpen({ kind: "github" })}
      />
      <KinSocialConnect environmentId={environmentId} orgId={orgId} />
      {view === null ? null : (
        <KinSettingsSection
          title={MAIL.otherServices}
          action={
            otherServices.length === 0 ? undefined : (
              <Button
                size="xs"
                variant="outline"
                onClick={() => setAdding({ title: MAIL.addServiceTitle, offered: otherServices })}
              >
                <PlusIcon />
                {MAIL.addService}
              </Button>
            )
          }
        >
          {others.length === 0 ? (
            <KinSettingsEmpty>{MAIL.otherServicesEmpty}</KinSettingsEmpty>
          ) : (
            others
              .toSorted((a, b) => needsLook(a) - needsLook(b) || a.label.localeCompare(b.label))
              .map((connection) =>
                openRow(connection, connection.label, kinConnectionProvider(connection)),
              )
          )}
        </KinSettingsSection>
      )}
      <KinVisualHosts environmentId={environmentId} orgId={orgId} />
      {adding !== null && view !== null ? (
        <AddDialog
          title={adding.title}
          offered={adding.offered}
          services={view.services}
          signInAddress={view.signInAddress}
          actions={actions}
          onClose={() => setAdding(null)}
          onAdded={(id) => {
            setAdding(null);
            setOpen({ kind: "connection", id });
          }}
        />
      ) : null}
    </KinSettingsPage>
  );
}

type Waiting = { readonly host: string; readonly url: string; readonly opened: boolean };

function AddDialog(props: {
  readonly title: string;
  /** The services offered: one (Google) skips the choice; the full list for Other services. */
  readonly offered: ReadonlyArray<KinConnectionService>;
  readonly services: ReadonlyArray<KinConnectionService>;
  readonly signInAddress: string;
  readonly actions: ReturnType<typeof createKinConnectionActions>;
  readonly onClose: () => void;
  readonly onAdded: (id: KinConnectionId) => void;
}) {
  const services = kinAddableServices(props.offered);
  const first = services.find((entry) => entry.available)?.service ?? "custom";
  const [draft, setDraft] = useState<KinConnectionDraft>(() => kinConnectionDraft(first));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<Waiting | null>(null);
  const [changingClient, setChangingClient] = useState(false);
  const [ownClient, setOwnClient] = useState(false);
  const ids = {
    clientId: useId(),
    clientSecret: useId(),
    service: useId(),
    name: useId(),
    url: useId(),
    key: useId(),
    org: useId(),
    secretUrl: useId(),
  };
  const service = services.find((entry) => entry.service === draft.service);
  const custom = draft.service === "custom";
  const signIn = service?.connect === "sign_in";
  const ownerClient =
    service !== undefined && kinIsOwnerClientService(service.service) ? service.service : null;
  const setup = signIn && !ownClient && (service?.needsSetup === true || changingClient);
  const accountClient =
    signIn && ownerClient !== null ? KIN_OWNER_CLIENT_SETUP[ownerClient].accountClient : null;

  const submit = async () => {
    if (busy || setup) return;
    setBusy(true);
    setProblem(null);
    if (signIn) {
      const popup = openSignInWindow();
      const started = await props.actions.signInNew(draft, props.services, "web");
      setBusy(false);
      if (!started.ok) {
        popup?.close();
        return setProblem(started.problem);
      }
      if (popup !== null) popup.location.href = started.value.authorizationUrl;
      setWaiting({
        host: started.value.host,
        url: started.value.authorizationUrl,
        opened: popup !== null,
      });
      return;
    }
    const outcome = await props.actions.add(draft, props.services);
    setBusy(false);
    if (outcome.ok) props.onAdded(outcome.value);
    else setProblem(outcome.problem);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) props.onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{props.title}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                {services.length === 1 ? null : (
                  <>
                    <Label htmlFor={ids.service}>{COPY.serviceLabel}</Label>
                    <Select
                      items={services.map((entry) => ({
                        value: entry.service,
                        label: entry.label,
                      }))}
                      value={draft.service}
                      onValueChange={(value) => {
                        const picked = services.find((entry) => entry.service === value);
                        if (picked === undefined || !picked.available) return;
                        setProblem(null);
                        setWaiting(null);
                        setChangingClient(false);
                        setOwnClient(false);
                        setDraft({ ...kinConnectionDraft(picked.service), key: draft.key });
                      }}
                    >
                      <SelectTrigger id={ids.service} aria-label={COPY.serviceLabel}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectPopup>
                        {services.map((entry) => (
                          <SelectItem
                            key={entry.service}
                            value={entry.service}
                            disabled={!entry.available}
                          >
                            {kinServiceNote(entry) === undefined
                              ? entry.label
                              : `${entry.label} · ${kinServiceNote(entry)}`}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  </>
                )}
                {service?.setup == null ? null : (
                  <p className="text-xs text-muted-foreground">{service.setup}</p>
                )}
                {signIn && !setup && waiting === null && service !== undefined ? (
                  <p className="text-xs text-muted-foreground">
                    {COPY.signInOpens(
                      ownerClient === null
                        ? service.label
                        : KIN_OWNER_CLIENT_SETUP[ownerClient].host,
                    )}
                  </p>
                ) : null}
              </div>
              {custom ? (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={ids.url}>{COPY.urlLabel}</Label>
                  <Input
                    id={ids.url}
                    value={draft.url}
                    placeholder={COPY.urlPlaceholder}
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    onChange={(event) => setDraft({ ...draft, url: event.target.value })}
                  />
                </div>
              ) : null}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={ids.name}>{COPY.nameLabel}</Label>
                <Input
                  id={ids.name}
                  value={draft.label}
                  maxLength={80}
                  placeholder={custom ? COPY.namePlaceholder : (service?.label ?? "")}
                  autoComplete="off"
                  onChange={(event) => setDraft({ ...draft, label: event.target.value })}
                />
              </div>
              {signIn ? null : (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={ids.key}>{COPY.keyLabel}</Label>
                  <Input
                    id={ids.key}
                    type="password"
                    value={draft.key}
                    placeholder={COPY.keyPlaceholder}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => setDraft({ ...draft, key: event.target.value })}
                  />
                  <p className="text-xs text-muted-foreground">
                    {custom ? `${COPY.keyOptional} ${COPY.keyHint}` : COPY.keyHint}
                  </p>
                </div>
              )}
              {service?.fields.includes("org") === true ? (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={ids.org}>{COPY.orgLabel}</Label>
                  <Input
                    id={ids.org}
                    value={draft.org}
                    placeholder={COPY.orgPlaceholder}
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    onChange={(event) => setDraft({ ...draft, org: event.target.value })}
                  />
                </div>
              ) : null}
              {service?.fields.includes("secretUrl") === true ? (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={ids.secretUrl}>{COPY.secretUrlLabel}</Label>
                  <Input
                    id={ids.secretUrl}
                    type="password"
                    value={draft.secretUrl}
                    placeholder={COPY.secretUrlPlaceholder}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => setDraft({ ...draft, secretUrl: event.target.value })}
                  />
                  <p className="text-xs text-muted-foreground">{COPY.secretUrlHint}</p>
                </div>
              ) : null}
              {setup && ownerClient !== null ? (
                <OwnerClientSetup
                  key={ownerClient}
                  service={ownerClient}
                  signInAddress={props.signInAddress}
                  disabled={busy}
                  onSave={async (clientId, clientSecret) => {
                    const saved = await props.actions.setOwnerClient(
                      ownerClient,
                      clientId,
                      clientSecret,
                    );
                    if (!saved.ok) return saved.problem;
                    setChangingClient(false);
                    return null;
                  }}
                />
              ) : signIn && ownerClient !== null && !ownClient ? (
                <div className="flex flex-wrap gap-1">
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    onClick={() => setChangingClient(true)}
                  >
                    {KIN_OWNER_CLIENT_SETUP[ownerClient].changeClient}
                  </Button>
                  {accountClient === null ? null : (
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      onClick={() => setOwnClient(true)}
                    >
                      {accountClient.label}
                    </Button>
                  )}
                </div>
              ) : null}
              {accountClient !== null && ownerClient !== null && ownClient ? (
                <fieldset className="flex flex-col gap-3 rounded-md border border-border p-3">
                  <legend className="px-1 text-xs font-medium text-foreground">
                    {accountClient.label}
                  </legend>
                  <p className="text-xs text-muted-foreground">{accountClient.detail}</p>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={ids.clientId}>
                      {KIN_OWNER_CLIENT_SETUP[ownerClient].clientIdLabel}
                    </Label>
                    <Input
                      id={ids.clientId}
                      value={draft.clientId}
                      placeholder={KIN_OWNER_CLIENT_SETUP[ownerClient].clientIdPlaceholder}
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(event) => setDraft({ ...draft, clientId: event.target.value })}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={ids.clientSecret}>
                      {KIN_OWNER_CLIENT_SETUP[ownerClient].secretLabel}
                    </Label>
                    <Input
                      id={ids.clientSecret}
                      type="password"
                      value={draft.clientSecret}
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(event) => setDraft({ ...draft, clientSecret: event.target.value })}
                    />
                  </div>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    className="self-start"
                    onClick={() => {
                      setOwnClient(false);
                      setDraft({ ...draft, clientId: "", clientSecret: "" });
                    }}
                  >
                    {COPY.usualClient}
                  </Button>
                </fieldset>
              ) : null}
              {waiting === null ? null : (
                <SignInWaiting
                  host={waiting.host}
                  authorizationUrl={waiting.url}
                  signInAddress={props.signInAddress}
                  opened={waiting.opened}
                  onFinish={async (response) => {
                    const done = await props.actions.signInFinish(response);
                    if (!done.ok) return done.problem;
                    props.onAdded(done.value);
                    return null;
                  }}
                />
              )}
              {problem === null ? null : (
                <Alert variant="error">
                  <AlertDescription>{problem}</AlertDescription>
                </Alert>
              )}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={props.onClose}>
              {KIN_SETTINGS_COPY.cancel}
            </Button>
            {setup || waiting !== null ? null : (
              <Button type="submit" disabled={busy} aria-busy={busy}>
                {busy ? COPY.connecting : signIn ? COPY.signIn : COPY.connect}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
