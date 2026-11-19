import { KIN_RETRY } from "@t3tools/client-runtime/kin/kinAnswers";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  KIN_CONNECTIONS_COPY as COPY,
  createKinConnectionActions,
  KIN_OWNER_CLIENT_SETUP,
  kinAcceptAll,
  kinAddableServices,
  kinCallRow,
  kinConnectionChange,
  kinConnectionDraft,
  kinConnectionProvider,
  kinConnectionStatus,
  kinIsOwnerClientService,
  kinServiceNote,
  kinSuggestedModes,
  kinToolRows,
  kinToolMark,
  kinToolModeLabel,
  type KinConnectionDraft,
  type KinConnectionTone,
  type KinToolRow,
} from "@t3tools/client-runtime/kin/kinConnections";
import {
  KinConnectionKey,
  type EnvironmentId,
  type KinConnection,
  type KinConnectionId,
  type KinConnectionService,
  type KinConnectionToolMode,
  type KinOrgId,
} from "@t3tools/contracts";
import { useLocation } from "@tanstack/react-router";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { ChevronLeftIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { searchableSetting } from "../components/settings/settingsSearch";
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
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "../components/ui/empty";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import { useAtomCommand } from "../state/use-atom-command";
import { KinConfirm } from "./KinConfirm";
import { KinGitHubConnect } from "./KinGitHubConnect";
import { KinSocialConnect } from "./KinSocialConnect";
import { kinNewLeadTarget } from "./KinNewLeadButton";
import { KinVisualHosts } from "./KinVisualHosts";
import { kinClient } from "./kinClient";
import { OwnerClientSetup, openSignInWindow, SignInWaiting } from "./KinConnectionSignIn";
import { kinSettingsFindIn } from "./kinSettingsAddress";
import { useKinHost } from "./useKinHost";
import { useNowMinuteMs } from "./useKinClock";

type Target = { readonly environmentId: EnvironmentId; readonly orgId: KinOrgId };

const TONE_BADGE: Record<KinConnectionTone, "success" | "warning" | "error" | "outline"> = {
  ok: "success",
  attention: "warning",
  error: "error",
  muted: "outline",
};

const makeKey = Schema.decodeSync(KinConnectionKey);

/** Settings → Connections: the owner's list; a connection opens as its record in a sheet. */
export function KinConnectionsSettings() {
  const target = kinNewLeadTarget(useKinHost());
  return target === null ? (
    <Empty size="compact">
      <EmptyHeader>
        <EmptyTitle>{COPY.title}</EmptyTitle>
        <EmptyDescription>Connect to your Kin to manage its connections.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  ) : (
    <>
      <KinGitHubConnect environmentId={target.environmentId} orgId={target.orgId} />
      <KinSocialConnect environmentId={target.environmentId} orgId={target.orgId} />
      <ConnectionsList environmentId={target.environmentId} orgId={target.orgId} />
      <KinVisualHosts environmentId={target.environmentId} orgId={target.orgId} />
    </>
  );
}

function ConnectionsList(props: Target) {
  const { environmentId, orgId } = props;
  const listAtom = kinClient.connections({ environmentId, input: { orgId } });
  const result = useAtomValue(listAtom);
  const reload = useAtomRefresh(listAtom);
  const view = Option.getOrNull(AsyncResult.value(result));
  const [adding, setAdding] = useState(false);
  // A link into Settings can name the connection to open at, as a done suggestion does.
  const named = useLocation({ select: (location) => kinSettingsFindIn(location.searchStr) });
  const [open, setOpen] = useState<string | null>(named === "" ? null : named);
  const add = useAtomCommand(kinClient.connectionAdd, { reportFailure: false });
  const remove = useAtomCommand(kinClient.connectionRemove, { reportFailure: false });
  const signInStart = useAtomCommand(kinClient.connectionSignInStart, { reportFailure: false });
  const signInFinish = useAtomCommand(kinClient.connectionSignInFinish, { reportFailure: false });
  const setSignInClient = useAtomCommand(kinClient.connectionSetSignInClient, {
    reportFailure: false,
  });
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
  const openConnection = connections.find((entry) => entry.connectionId === open) ?? null;

  if (openConnection !== null)
    return (
      <ConnectionRecord
        environmentId={environmentId}
        orgId={orgId}
        connection={openConnection}
        actions={actions}
        signInAddress={view?.signInAddress ?? ""}
        onRemove={async () => {
          const outcome = await actions.remove(openConnection.connectionId);
          if (outcome.ok) setOpen(null);
          return outcome.ok ? null : outcome.problem;
        }}
        onClose={() => setOpen(null)}
      />
    );

  return (
    <>
      <SettingsSection
        {...searchableSetting("kin-connections")}
        title={COPY.title}
        headerAction={
          view === null || connections.length === 0 ? null : (
            <Button size="xs" variant="outline" onClick={() => setAdding(true)}>
              <PlusIcon />
              {COPY.add}
            </Button>
          )
        }
      >
        {view === null ? (
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
        ) : connections.length === 0 ? (
          <Empty size="compact">
            <EmptyHeader>
              <EmptyTitle>{COPY.emptyTitle}</EmptyTitle>
              <EmptyDescription>{COPY.emptyDetail}</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button onClick={() => setAdding(true)}>{COPY.add}</Button>
            </EmptyContent>
          </Empty>
        ) : (
          connections.map((connection) => {
            const status = kinConnectionStatus(connection);
            return (
              <SettingsRow
                key={connection.connectionId}
                title={connection.label}
                description={[kinConnectionProvider(connection), connection.note, status.detail]
                  .filter(Boolean)
                  .join(" · ")}
                status={<Badge variant={TONE_BADGE[status.tone]}>{status.label}</Badge>}
                control={
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => setOpen(connection.connectionId)}
                  >
                    Open
                  </Button>
                }
              />
            );
          })
        )}
      </SettingsSection>
      <p className="-mt-5 px-3 text-xs text-muted-foreground sm:px-4">{COPY.intro}</p>
      {adding && view !== null ? (
        <AddDialog
          services={view.services}
          signInAddress={view.signInAddress}
          actions={actions}
          onClose={() => setAdding(false)}
          onAdded={(id) => {
            setAdding(false);
            setOpen(id);
          }}
        />
      ) : null}
    </>
  );
}

type Waiting = { readonly host: string; readonly url: string; readonly opened: boolean };

function AddDialog(props: {
  readonly services: ReadonlyArray<KinConnectionService>;
  readonly signInAddress: string;
  readonly actions: ReturnType<typeof createKinConnectionActions>;
  readonly onClose: () => void;
  readonly onAdded: (id: KinConnectionId) => void;
}) {
  const services = kinAddableServices(props.services);
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
            <DialogTitle>{COPY.addTitle}</DialogTitle>
            <DialogDescription>{COPY.intro}</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={ids.service}>{COPY.serviceLabel}</Label>
                <Select
                  items={services.map((entry) => ({ value: entry.service, label: entry.label }))}
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
              Cancel
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

type Editing = "rename" | "key" | "note" | null;

function ConnectionRecord(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly connection: KinConnection;
  readonly actions: ReturnType<typeof createKinConnectionActions>;
  readonly signInAddress: string;
  readonly onRemove: () => Promise<string | null>;
  readonly onClose: () => void;
}) {
  const { environmentId, orgId } = props;
  const [waiting, setWaiting] = useState<Waiting | null>(null);
  const ref = { orgId, connectionId: props.connection.connectionId };
  const detailAtom = kinClient.connection({ environmentId, input: ref });
  const detail = Option.getOrNull(AsyncResult.value(useAtomValue(detailAtom)));
  const reload = useAtomRefresh(detailAtom);
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
  const setKey = useAtomCommand(kinClient.connectionSetKey, { reportFailure: false });
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [confirming, setConfirming] = useState(false);
  const reachId = useId();

  const connection = detail?.connection ?? props.connection;
  const status = kinConnectionStatus(connection);
  const rows = kinToolRows(detail?.tools ?? []);
  const suggested = kinSuggestedModes(rows);
  const changed = rows.filter((row) => row.state === "changed");

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
  const signInAgain = async () => {
    setProblem(null);
    const popup = openSignInWindow();
    const started = await props.actions.signInAgain(connection.connectionId, "web");
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
  };
  const markTool = (row: KinToolRow, mode: KinConnectionToolMode) =>
    run(`tool:${row.name}`, "change that tool", () =>
      setModes({ environmentId, input: { ...ref, modes: kinToolMark(row, mode) } }),
    );

  return (
    <>
      <div className="flex flex-col gap-6 px-3 sm:px-4">
        <div className="flex flex-col items-start gap-2">
          <Button size="xs" variant="ghost" onClick={props.onClose}>
            <ChevronLeftIcon />
            {COPY.title}
          </Button>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold text-foreground">{connection.label}</h2>
            <Badge variant={TONE_BADGE[status.tone]}>{status.label}</Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            {connection.accountLabel === null
              ? connection.urlHost
              : `${connection.accountLabel} · ${connection.urlHost}`}
          </p>
        </div>
        {status.tone === "error" || status.tone === "attention" || connection.paused ? (
          <Alert
            variant={
              status.tone === "error" ? "error" : status.tone === "attention" ? "warning" : "info"
            }
          >
            <AlertDescription>{status.detail}</AlertDescription>
          </Alert>
        ) : null}
        {problem === null ? null : (
          <Alert variant="error">
            <AlertDescription role="alert">{problem}</AlertDescription>
          </Alert>
        )}
        {connection.auth === "oauth" &&
        (connection.state === "needs_sign_in" || connection.needsSignInToSend === true) &&
        waiting === null ? (
          <Button
            size="sm"
            className="self-start"
            disabled={busy !== null}
            onClick={() => void signInAgain()}
          >
            {COPY.signInAgain}
          </Button>
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
              setWaiting(null);
              reload();
              return null;
            }}
          />
        )}

        {connection.kind === "builtin" ? (
          <Section
            title={COPY.accountTitle}
            action={
              <Button size="xs" variant="ghost" onClick={() => setEditing("note")}>
                {connection.note == null ? COPY.noteAdd : COPY.noteEdit}
              </Button>
            }
          >
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-muted-foreground">{COPY.noteLabel}</dt>
              <dd className={connection.note == null ? "text-muted-foreground" : "text-foreground"}>
                {connection.note ?? COPY.noteNone}
              </dd>
              {(connection.sendAs ?? []).length === 0 ? null : (
                <>
                  <dt className="text-muted-foreground">{COPY.sendsFrom}</dt>
                  <dd className="flex min-w-0 flex-col gap-0.5">
                    {(connection.sendAs ?? []).map((one) => (
                      <span key={one.address} className="break-words text-foreground">
                        {one.name === null ? one.address : `${one.name} <${one.address}>`}
                        {one.isDefault ? (
                          <span className="text-muted-foreground"> · {COPY.defaultAddress}</span>
                        ) : null}
                      </span>
                    ))}
                  </dd>
                </>
              )}
            </dl>
          </Section>
        ) : null}

        <Section
          title={COPY.toolsTitle}
          action={
            <Button
              size="xs"
              variant="ghost"
              disabled={busy !== null}
              onClick={() =>
                void run("refresh", "check for changes", () =>
                  refresh({ environmentId, input: ref }),
                )
              }
            >
              <RefreshCwIcon />
              {busy === "refresh" ? COPY.refreshing : COPY.refresh}
            </Button>
          }
        >
          <p className="text-xs text-muted-foreground">{COPY.toolsDetail}</p>
          {changed.length > 1 ? (
            <Button
              size="sm"
              variant="outline"
              className="self-start"
              disabled={busy !== null}
              onClick={() =>
                void run("accept", "allow the changes", () =>
                  accept({ environmentId, input: kinAcceptAll(ref, connection, rows) }),
                )
              }
            >
              {COPY.acceptAll}
            </Button>
          ) : null}
          {suggested.length > 0 ? (
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">{COPY.suggestedDetail}</p>
              <Button
                size="xs"
                variant="outline"
                disabled={busy !== null}
                onClick={() =>
                  void run("suggested", "turn those on", () =>
                    setModes({ environmentId, input: { ...ref, modes: suggested } }),
                  )
                }
              >
                {COPY.suggested} ({suggested.length})
              </Button>
            </div>
          ) : null}
          {detail === null ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">{COPY.noTools}</p>
          ) : (
            <ul className="flex flex-col">
              {rows.map((row) => (
                <ToolItem
                  key={row.name}
                  row={row}
                  disabled={busy !== null}
                  onMark={(mode) => void markTool(row, mode)}
                  onAccept={() =>
                    void run(`accept:${row.name}`, "allow the new version", () =>
                      accept({
                        environmentId,
                        input: { ...ref, tools: [{ tool: row.name, digest: row.digest }] },
                      }),
                    )
                  }
                />
              ))}
            </ul>
          )}
        </Section>

        <Section title={COPY.callsTitle}>
          {calls === null ? null : calls.calls.length === 0 ? (
            <p className="text-sm text-muted-foreground">{COPY.noCalls}</p>
          ) : (
            <ul className="flex flex-col">
              {calls.calls.map((call) => {
                const line = kinCallRow(call, new Date(nowMs), rows);
                return (
                  <li
                    key={line.key}
                    className="flex items-start justify-between gap-3 border-b border-border/60 py-2 last:border-b-0"
                  >
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate text-sm">{line.title}</span>
                      <span
                        className={
                          line.ok
                            ? "text-xs text-muted-foreground"
                            : "text-xs text-destructive-foreground"
                        }
                      >
                        {line.detail}
                      </span>
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                      {line.time}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>

        <Section title="Connection">
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-col gap-0.5">
              <Label htmlFor={reachId}>{COPY.reachTitle}</Label>
              <p className="text-xs text-muted-foreground">{COPY.reachDetail}</p>
            </div>
            <Switch
              id={reachId}
              checked={connection.reach === "closed"}
              disabled={busy !== null}
              onCheckedChange={(checked) =>
                void run("reach", "change that", () =>
                  setReach({
                    environmentId,
                    input: { ...ref, reach: checked ? "closed" : "open" },
                  }),
                )
              }
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => setEditing("rename")}>
              {COPY.rename}
            </Button>
            {connection.auth === "key" ? (
              <Button size="sm" variant="outline" onClick={() => setEditing("key")}>
                {COPY.replaceKey}
              </Button>
            ) : null}
            {connection.auth === "oauth" && connection.state !== "needs_sign_in" ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null || waiting !== null}
                onClick={() => void signInAgain()}
              >
                {COPY.signInAgain}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() =>
                void run("pause", connection.paused ? "resume it" : "pause it", () =>
                  update({ environmentId, input: { ...ref, paused: !connection.paused } }),
                )
              }
            >
              {connection.paused ? COPY.resume : COPY.pause}
            </Button>
            <Button
              size="sm"
              variant="destructive-outline"
              disabled={busy !== null}
              onClick={() => setConfirming(true)}
            >
              {COPY.remove}
            </Button>
          </div>
        </Section>
      </div>
      {editing === null ? null : (
        <EditDialog
          editing={editing}
          label={editing === "note" ? (connection.note ?? "") : connection.label}
          onClose={() => setEditing(null)}
          onSave={async (value) => {
            const failed = await kinConnectionChange(
              editing === "rename"
                ? update({ environmentId, input: { ...ref, label: value.trim() } })
                : editing === "note"
                  ? update({
                      environmentId,
                      input: { ...ref, note: value.trim() === "" ? null : value.trim() },
                    })
                  : setKey({ environmentId, input: { ...ref, key: makeKey(value.trim()) } }),
              editing === "rename"
                ? "rename it"
                : editing === "note"
                  ? "save the note"
                  : "replace the key",
            );
            reload();
            if (failed === null) setEditing(null);
            return failed;
          }}
        />
      )}
      <KinConfirm
        ask={
          confirming
            ? {
                title: COPY.removeTitle(connection.label),
                detail: COPY.removeDetail,
                action: COPY.removeConfirm,
                destructive: true,
              }
            : null
        }
        onConfirm={() =>
          void props.onRemove().then((failed) => {
            if (failed !== null) setProblem(failed);
          })
        }
        onClose={() => setConfirming(false)}
      />
    </>
  );
}

function ToolItem(props: {
  readonly row: KinToolRow;
  readonly disabled: boolean;
  readonly onMark: (mode: KinConnectionToolMode) => void;
  readonly onAccept: () => void;
}) {
  const { row } = props;
  const id = useId();
  return (
    <li className="flex flex-col gap-2 border-b border-border/60 py-3 last:border-b-0">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <Label htmlFor={id} className="break-words">
            {row.title}
          </Label>
          {row.description === null || row.change !== null ? null : (
            <p className="line-clamp-3 text-xs text-muted-foreground">{row.description}</p>
          )}
          <div className="flex flex-wrap gap-1">
            {row.alwaysAsk ? <Badge variant="outline">{COPY.alwaysAsk}</Badge> : null}
            {row.openWeb ? <Badge variant="outline">{COPY.openWeb}</Badge> : null}
            {row.state === "changed" ? <Badge variant="warning">{COPY.changedTitle}</Badge> : null}
          </div>
        </div>
        <ToggleGroup
          id={id}
          aria-label={`${row.title}: ${kinToolModeLabel(row.mode)}`}
          className="shrink-0"
          value={[row.mode]}
          disabled={props.disabled}
          onValueChange={(next) => {
            const mode = row.modes.find((one) => one === next[0]);
            if (mode !== undefined && mode !== row.mode) props.onMark(mode);
          }}
        >
          {row.modes.map((mode) => (
            <Toggle key={mode} value={mode}>
              {kinToolModeLabel(mode)}
            </Toggle>
          ))}
        </ToggleGroup>
      </div>
      {row.change === null ? null : (
        <div className="flex flex-col gap-2 rounded-md bg-muted/40 p-3 text-xs">
          <p className="text-muted-foreground">{COPY.changedDetail}</p>
          <div className="flex flex-col gap-0.5">
            <span className="font-medium">Before</span>
            <p className="whitespace-pre-line text-muted-foreground">
              {row.change.before ?? "No description."}
            </p>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="font-medium">Now</span>
            <p className="whitespace-pre-line">{row.change.after ?? "No description."}</p>
          </div>
          {row.change.inputsChanged ? <p>{COPY.inputsChanged}</p> : null}
          {row.change.labelsChanged ? <p>{COPY.describedChanged}</p> : null}
          <Button
            size="xs"
            variant="outline"
            className="self-start"
            disabled={props.disabled}
            onClick={props.onAccept}
          >
            {COPY.accept}
          </Button>
        </div>
      )}
    </li>
  );
}

function EditDialog(props: {
  readonly editing: "rename" | "key" | "note";
  readonly label: string;
  readonly onSave: (value: string) => Promise<string | null>;
  readonly onClose: () => void;
}) {
  const rename = props.editing === "rename";
  const note = props.editing === "note";
  const text = rename || note;
  const [value, setValue] = useState(text ? props.label : "");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const id = useId();
  const max = rename ? 80 : note ? 200 : 4096;
  const valid = (note || value.trim() !== "") && value.trim().length <= max;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) props.onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            if (!valid || busy) return;
            setBusy(true);
            setProblem(null);
            void props.onSave(value).then((failed) => {
              setBusy(false);
              setProblem(failed);
            });
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {rename ? COPY.renameTitle : note ? COPY.noteTitle : COPY.replaceKeyTitle}
            </DialogTitle>
            {rename ? null : (
              <DialogDescription>{note ? COPY.noteHint : COPY.replaceKeyDetail}</DialogDescription>
            )}
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={id}>
                  {rename ? COPY.nameLabel : note ? COPY.noteLabel : COPY.keyLabel}
                </Label>
                <Input
                  id={id}
                  type={text ? "text" : "password"}
                  value={value}
                  maxLength={max}
                  placeholder={
                    rename
                      ? COPY.namePlaceholder
                      : note
                        ? COPY.notePlaceholder
                        : COPY.keyPlaceholder
                  }
                  autoComplete="off"
                  spellCheck={false}
                  autoFocus
                  onChange={(event) => setValue(event.target.value)}
                />
                {text ? null : <p className="text-xs text-muted-foreground">{COPY.keyHint}</p>}
              </div>
              {problem === null ? null : (
                <Alert variant="error">
                  <AlertDescription>{problem}</AlertDescription>
                </Alert>
              )}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || busy} aria-busy={busy}>
              {COPY.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

function Section(props: {
  readonly title: string;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex min-h-7 items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">{props.title}</h3>
        {props.action}
      </div>
      {props.children}
    </section>
  );
}
