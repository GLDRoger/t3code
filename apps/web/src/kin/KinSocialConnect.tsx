import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  createKinSocialActions,
  KIN_SOCIAL_COPY as COPY,
  KIN_SOCIAL_LINK_PLATFORMS,
  kinSocialAccountLine,
  kinSocialChoices,
  kinSocialPlatformLabel,
  kinSocialRows,
  type KinSocialRow,
} from "@t3tools/client-runtime/kin/kinSocial";
import type {
  EnvironmentId,
  KinOrgId,
  KinSocialCheck,
  KinSocialLink,
  KinSocialPlatform,
  KinSocialView,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { PlusIcon } from "lucide-react";
import { useId, useState } from "react";

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
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { useAtomCommand } from "../state/use-atom-command";
import { KinConfirm } from "./KinConfirm";
import { kinClient } from "./kinClient";
import { KinSettingsFormDialog } from "./settings/KinSettingsControls";
import {
  KinSettingsEmpty,
  KinSettingsLoadFailed,
  KinSettingsLoading,
  KinSettingsRow,
  KinSettingsSection,
  KinSettingsStatus,
} from "./settings/KinSettingsLayout";
import { useKinOwnerLevel } from "./useKinOwnerLevel";

/** A state said only when it isn't fine: problems are badges. */
function ToneStatus(props: { readonly row: KinSocialRow }) {
  const { tone, label } = props.row;
  if (tone === "ok") return null;
  return <KinSettingsStatus tone={tone === "muted" ? "quiet" : tone}>{label}</KinSettingsStatus>;
}

type Actions = ReturnType<typeof createKinSocialActions>;
type Open =
  | { readonly kind: "add" }
  | { readonly kind: "group"; readonly row: KinSocialRow }
  | { readonly kind: "rekey"; readonly row: KinSocialRow }
  | { readonly kind: "link"; readonly row: KinSocialRow };

/** Settings → Connections → Social accounts, for the owner and co-owners only. */
export function KinSocialConnect(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
}) {
  return useKinOwnerLevel(props.environmentId) ? <SocialSection {...props} /> : null;
}

function SocialSection(props: { readonly environmentId: EnvironmentId; readonly orgId: KinOrgId }) {
  const { environmentId, orgId } = props;
  const viewAtom = kinClient.social({ environmentId, input: { orgId } });
  const result = useAtomValue(viewAtom);
  const reload = useAtomRefresh(viewAtom);
  const view = Option.getOrNull(AsyncResult.value(result));
  const check = useAtomCommand(kinClient.socialCheck, { reportFailure: false });
  const connect = useAtomCommand(kinClient.socialConnect, { reportFailure: false });
  const refresh = useAtomCommand(kinClient.socialRefresh, { reportFailure: false });
  const remove = useAtomCommand(kinClient.socialRemove, { reportFailure: false });
  const link = useAtomCommand(kinClient.socialLink, { reportFailure: false });
  const actions = createKinSocialActions({
    orgId,
    check: (input) => check({ environmentId, input }),
    connect: (input) => connect({ environmentId, input }),
    refresh: (input) => refresh({ environmentId, input }),
    remove: (input) => remove({ environmentId, input }),
    link: (input) => link({ environmentId, input }),
    reload,
  });
  const [open, setOpen] = useState<Open | null>(null);
  const [removing, setRemoving] = useState<KinSocialRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const rows = view === null ? [] : kinSocialRows(view);
  const choices = view === null ? [] : kinSocialChoices(view);

  const checkAgain = async (row: KinSocialRow) => {
    setBusy(true);
    setProblem(null);
    const outcome = await actions.refresh(row.groupId);
    setBusy(false);
    if (outcome.ok) setOpen(null);
    else setProblem(outcome.problem);
  };

  return (
    <>
      <KinSettingsSection
        title={COPY.title}
        action={
          view !== null && choices.length > 0 ? (
            <Button size="xs" variant="outline" onClick={() => setOpen({ kind: "add" })}>
              <PlusIcon />
              {COPY.add}
            </Button>
          ) : undefined
        }
        problem={open === null ? problem : null}
      >
        {view === null ? (
          AsyncResult.isFailure(result) ? (
            <KinSettingsLoadFailed onRetry={reload}>{COPY.loadFailed}</KinSettingsLoadFailed>
          ) : (
            <KinSettingsLoading rows={1} />
          )
        ) : rows.length === 0 ? (
          <KinSettingsEmpty>{COPY.settingsEmpty}</KinSettingsEmpty>
        ) : (
          rows
            .toSorted((a, b) => Number(a.tone === "ok") - Number(b.tone === "ok"))
            .map((row) => (
              <KinSettingsRow
                key={row.groupId}
                title={row.title}
                wrap
                detail={
                  row.tone === "ok" && row.accounts.length > 0
                    ? row.accounts.map((account) => account.line).join(", ")
                    : row.detail
                }
                status={<ToneStatus row={row} />}
                openLabel={`${COPY.open}: ${row.title}`}
                onOpen={() => {
                  setProblem(null);
                  setOpen({ kind: "group", row });
                }}
              />
            ))
        )}
      </KinSettingsSection>
      {open?.kind === "group" ? (
        <KinSettingsFormDialog
          title={open.row.title}
          description={open.row.detail}
          submitLabel={open.row.linkLabel}
          busy={busy}
          problem={problem}
          remove={
            <Button
              type="button"
              variant="ghost-destructive"
              disabled={busy}
              onClick={() => setRemoving(open.row)}
            >
              {COPY.remove}
            </Button>
          }
          secondary={
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              aria-busy={busy}
              onClick={() =>
                open.row.tone === "error"
                  ? setOpen({ kind: "rekey", row: open.row })
                  : void checkAgain(open.row)
              }
            >
              {open.row.tone === "error" ? COPY.reconnect : COPY.refresh}
            </Button>
          }
          onSubmit={() => setOpen({ kind: "link", row: open.row })}
          onClose={() => setOpen(null)}
        >
          {open.row.accounts.length === 0 ? (
            <p className="text-sm text-muted-foreground">{COPY.noAccountsYet}</p>
          ) : (
            <ul className="flex flex-col divide-y rounded-lg border">
              {open.row.accounts.map((account) => (
                <li key={account.accountId} className="flex flex-col gap-0.5 px-3 py-2">
                  <span className="truncate text-sm text-foreground">{account.line}</span>
                  {account.problem === null ? null : (
                    <span className="text-xs text-warning-foreground">{account.problem}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </KinSettingsFormDialog>
      ) : null}
      {view !== null && (open?.kind === "add" || open?.kind === "rekey") ? (
        <ConnectDialog
          view={view}
          rekey={open.kind === "rekey" ? open.row : null}
          actions={actions}
          onClose={() => setOpen(null)}
        />
      ) : null}
      {open?.kind === "link" ? (
        <LinkDialog row={open.row} actions={actions} onClose={() => setOpen(null)} />
      ) : null}
      <KinConfirm
        ask={
          removing === null
            ? null
            : {
                title: COPY.removeTitle(removing.title),
                detail: COPY.removeDetail,
                action: COPY.remove,
                destructive: true,
              }
        }
        onConfirm={() => {
          const row = removing;
          setRemoving(null);
          if (row === null) return;
          setOpen(null);
          void actions.remove(row.groupId).then((outcome) => {
            if (!outcome.ok) setProblem(outcome.problem);
          });
        }}
        onClose={() => setRemoving(null)}
      />
    </>
  );
}

/** Pick whose accounts, paste that profile's key, see what it reaches, then connect. */
function ConnectDialog(props: {
  readonly view: KinSocialView;
  readonly rekey: KinSocialRow | null;
  readonly actions: Actions;
  readonly onClose: () => void;
}) {
  const { view, rekey, actions } = props;
  const choices = kinSocialChoices(view);
  const [pick, setPick] = useState(rekey === null ? 0 : -1);
  const [key, setKey] = useState("");
  const [checked, setChecked] = useState<KinSocialCheck | null>(null);
  // The label it connected: once connected, that group leaves the choices.
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const keyId = useId();
  const chosen = rekey === null ? choices[pick] : undefined;
  const label = rekey?.title ?? chosen?.label ?? "";

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    if (checked === null) {
      const outcome = await actions.check(
        rekey === null
          ? { kind: chosen?.kind ?? "own", clientId: chosen?.clientId, key }
          : { kind: rekey.kind, groupId: rekey.groupId, key },
      );
      setBusy(false);
      if (!outcome.ok) return setProblem(outcome.problem);
      setKey("");
      return setChecked(outcome.value);
    }
    const outcome = await actions.connect(checked.checkId);
    setBusy(false);
    if (!outcome.ok) {
      setChecked(null);
      return setProblem(outcome.problem);
    }
    setDone(label);
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
            if (done !== null) props.onClose();
            else void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {rekey === null ? COPY.sheetTitle : `${COPY.reconnect}: ${rekey.title}`}
            </DialogTitle>
            <DialogDescription>{COPY.intro}</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {done !== null ? (
              <p className="text-sm text-foreground" aria-live="polite">
                {COPY.connected(done)}
              </p>
            ) : checked === null ? (
              <>
                {rekey === null ? (
                  <fieldset className="flex flex-col gap-2">
                    <legend className="mb-1 text-sm font-medium text-foreground">
                      {COPY.whose}
                    </legend>
                    {choices.length === 0 ? (
                      <p className="text-sm text-muted-foreground">{COPY.noClients}</p>
                    ) : (
                      choices.map((choice, index) => (
                        <label
                          key={choice.clientId ?? "own"}
                          className="flex min-h-10 cursor-pointer items-center gap-3 rounded-md border border-border px-3 text-sm has-checked:border-primary"
                        >
                          <input
                            type="radio"
                            name="social-whose"
                            className="size-4 accent-primary"
                            checked={pick === index}
                            onChange={() => setPick(index)}
                          />
                          <span className="text-foreground">{choice.label}</span>
                          {choice.kind === "client" ? (
                            <span className="text-xs text-muted-foreground">client</span>
                          ) : null}
                        </label>
                      ))
                    )}
                  </fieldset>
                ) : null}
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={keyId}>{COPY.keyLabel}</Label>
                  <Input
                    id={keyId}
                    type="password"
                    value={key}
                    placeholder={COPY.keyPlaceholder}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => setKey(event.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    {COPY.keyHint(view.service.label)}
                  </p>
                  <p className="text-xs text-muted-foreground">{view.service.setup}</p>
                  <a
                    className="self-start text-xs font-medium text-primary underline-offset-2 hover:underline"
                    href={view.service.keyUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {COPY.openService(view.service.label)}
                  </a>
                </div>
              </>
            ) : (
              <div className="flex flex-col gap-2" aria-live="polite">
                <p className="text-sm text-foreground">
                  {COPY.found(checked.profileName ?? checked.label)}
                </p>
                {checked.accounts.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{COPY.noAccounts}</p>
                ) : (
                  <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                    {checked.accounts.map((account) => (
                      <li key={account.accountId} className="flex flex-col px-3 py-2 text-sm">
                        <span className="text-foreground">{kinSocialAccountLine(account)}</span>
                        <span className="text-xs text-muted-foreground">
                          {account.problem ?? account.name}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="text-xs text-muted-foreground">{COPY.accountsFor(checked.label)}</p>
              </div>
            )}
            {problem === null ? null : (
              <Alert variant="error">
                <AlertDescription>{problem}</AlertDescription>
              </Alert>
            )}
          </DialogPanel>
          <DialogFooter>
            {done !== null ? (
              <Button type="submit">{COPY.done}</Button>
            ) : (
              <>
                <Button type="button" variant="outline" disabled={busy} onClick={props.onClose}>
                  {COPY.cancel}
                </Button>
                <Button
                  type="submit"
                  disabled={busy || (checked === null && (key.trim() === "" || label === ""))}
                  aria-busy={busy}
                >
                  {checked === null
                    ? busy
                      ? COPY.checking
                      : COPY.check
                    : busy
                      ? COPY.connecting
                      : COPY.confirm}
                </Button>
              </>
            )}
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

/** A one-time link the owner forwards; whoever opens it signs in to the platform themselves. */
function LinkDialog(props: {
  readonly row: KinSocialRow;
  readonly actions: Actions;
  readonly onClose: () => void;
}) {
  const { row, actions } = props;
  const broken = row.accounts.find((account) => account.problem !== null);
  const [platform, setPlatform] = useState<KinSocialPlatform>(broken?.platform ?? "instagram");
  const [made, setMade] = useState<KinSocialLink | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const platformId = useId();

  const make = async () => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const again = row.accounts.find(
      (account) => account.platform === platform && account.problem !== null,
    );
    const outcome = await actions.link(row.groupId, platform, again?.accountId);
    setBusy(false);
    if (!outcome.ok) return setProblem(outcome.problem);
    setCopied(false);
    setMade(outcome.value);
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
            void make();
          }}
        >
          <DialogHeader>
            <DialogTitle>{COPY.linkTitle(row.title)}</DialogTitle>
            <DialogDescription>
              {row.kind === "client" ? COPY.forwardLink : COPY.openSignedIn}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={platformId}>{COPY.linkPlatform}</Label>
              <Select
                value={platform}
                onValueChange={(value) => {
                  setPlatform(value as KinSocialPlatform);
                  setMade(null);
                }}
              >
                <SelectTrigger id={platformId} className="w-full min-w-0">
                  <SelectValue>{kinSocialPlatformLabel(platform)}</SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  {KIN_SOCIAL_LINK_PLATFORMS.map((one) => (
                    <SelectItem key={one.platform} value={one.platform}>
                      {one.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            {made === null ? null : (
              <div className="flex flex-col gap-2" aria-live="polite">
                <p className="break-all rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-xs text-foreground">
                  {made.url}
                </p>
                <p className="text-xs text-muted-foreground">{made.note}</p>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      void navigator.clipboard.writeText(made.url).then(() => setCopied(true))
                    }
                  >
                    {copied ? COPY.copied : COPY.copy}
                  </Button>
                  {typeof navigator.share === "function" ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void navigator.share({ url: made.url }).catch(() => undefined)}
                    >
                      {COPY.share}
                    </Button>
                  ) : null}
                </div>
              </div>
            )}
            {problem === null ? null : (
              <Alert variant="error">
                <AlertDescription>{problem}</AlertDescription>
              </Alert>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={props.onClose}>
              {made === null ? COPY.cancel : COPY.done}
            </Button>
            {made === null ? (
              <Button type="submit" disabled={busy} aria-busy={busy}>
                {busy ? COPY.linkMaking : COPY.linkMake}
              </Button>
            ) : null}
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
