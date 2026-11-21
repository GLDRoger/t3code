import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  KIN_CONNECTIONS_COPY as COPY,
  KIN_MAIL_COPY as MAIL,
  KIN_MAIL_PERMISSIONS,
  kinAcceptAll,
  kinConnectionStatus,
  kinIsMailConnection,
  kinMailAccountValue,
  kinMailModeLabel,
  kinMailModes,
  kinSuggestedModes,
  kinToolCopy,
  kinToolMark,
  kinMailToolOrder,
  kinToolRows,
  kinUseRow,
  type KinConnectionActions,
  type KinMailPermission,
  type KinToolRow,
} from "@t3tools/client-runtime/kin/kinConnections";
import { KIN_SETTINGS_COPY } from "@t3tools/client-runtime/kin/kinSettingsSpread";
import {
  KinConnectionKey,
  type EnvironmentId,
  type KinConnection,
  type KinConnectionTool,
  type KinConnectionToolMode,
  type KinOrgId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Switch } from "../components/ui/switch";
import { useAtomCommand } from "../state/use-atom-command";
import { KinConfirm } from "./KinConfirm";
import { openSignInWindow, SignInWaiting } from "./KinConnectionSignIn";
import { kinClient } from "./kinClient";
import {
  KinSettingsChoice,
  KinSettingsField,
  KinSettingsFormDialog,
  useKinSettingsSave,
} from "./settings/KinSettingsControls";
import {
  KinSettingsEmpty,
  KinSettingsLoading,
  KinSettingsPage,
  KinSettingsRow,
  KinSettingsSection,
  KinSettingsStatus,
} from "./settings/KinSettingsLayout";
import { useNowMinuteMs } from "./useKinClock";

const makeKey = Schema.decodeSync(KinConnectionKey);

type Waiting = { readonly host: string; readonly url: string; readonly opened: boolean };
type Editing = "rename" | "key" | "note";
/** Which section the last instant change came from, so its failure shows under that card. */
type Place = "permissions" | "tools" | "account" | "end";

/** Whether this account's value for a mail permission differs from the rest, from the list. */
export type KinMailDiffers = (
  permission: KinMailPermission,
  tools: ReadonlyArray<KinConnectionTool>,
) => boolean;

/**
 * One connection's own page: what agents may do in it, the account, each tool, recent use, and
 * Pause and Remove last. A mail account's three permissions say when they differ from the rest.
 */
export function KinConnectionPage(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly connection: KinConnection;
  readonly actions: KinConnectionActions;
  readonly signInAddress: string;
  readonly differs: KinMailDiffers;
  readonly onRemoved: () => void;
}) {
  const { environmentId, orgId } = props;
  const ref = { orgId, connectionId: props.connection.connectionId };
  const detailAtom = kinClient.connection({ environmentId, input: ref });
  const detail = Option.getOrNull(AsyncResult.value(useAtomValue(detailAtom)));
  const reload = useAtomRefresh(detailAtom);
  const callsResult = useAtomValue(
    kinClient.connectionCalls({ environmentId, input: { ...ref, limit: 20 } }),
  );
  const calls = Option.getOrNull(AsyncResult.value(callsResult));
  const nowMs = useNowMinuteMs();
  const setModes = useAtomCommand(kinClient.connectionSetToolModes, { reportFailure: false });
  const accept = useAtomCommand(kinClient.connectionAccept, { reportFailure: false });
  const refresh = useAtomCommand(kinClient.connectionRefresh, { reportFailure: false });
  const update = useAtomCommand(kinClient.connectionUpdate, { reportFailure: false });
  const setReach = useAtomCommand(kinClient.connectionSetReach, { reportFailure: false });
  const setKey = useAtomCommand(kinClient.connectionSetKey, { reportFailure: false });
  const save = useKinSettingsSave();
  const [place, setPlace] = useState<Place | null>(null);
  const [waiting, setWaiting] = useState<Waiting | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [looking, setLooking] = useState<KinToolRow | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  // Sign-in and Remove answer in their own words rather than through a command's result.
  const [aside, setAside] = useState<string | null>(null);

  const connection = detail?.connection ?? props.connection;
  const mail = kinIsMailConnection(connection);
  const status = kinConnectionStatus(connection);
  const tools = detail?.tools ?? [];
  const rows = mail ? kinMailToolOrder(kinToolRows(tools)) : kinToolRows(tools);
  // On a mail account the three choices above say what "suggested" would.
  const suggested = mail ? [] : kinSuggestedModes(rows);
  const changed = rows.filter((row) => row.state === "changed");
  const address = connection.accountLabel ?? connection.label;
  const problemAt = (here: Place) => (place === here ? (aside ?? save.problem) : null);

  const run = async (
    here: Place,
    key: string,
    doing: string,
    sent: Parameters<typeof save.run>[2],
  ) => {
    setPlace(here);
    setAside(null);
    await save.run(key, `Couldn't ${doing}.`, sent);
    reload();
  };
  const signInAgain = async () => {
    setPlace("account");
    setAside(null);
    const popup = openSignInWindow();
    const started = await props.actions.signInAgain(connection.connectionId, "web");
    if (!started.ok) {
      popup?.close();
      return setAside(started.problem);
    }
    if (popup !== null) popup.location.href = started.value.authorizationUrl;
    setWaiting({
      host: started.value.host,
      url: started.value.authorizationUrl,
      opened: popup !== null,
    });
  };
  const markTool = (row: KinToolRow, mode: KinConnectionToolMode) =>
    run("tools", `tool:${row.name}`, "change that tool", () =>
      setModes({ environmentId, input: { ...ref, modes: kinToolMark(row, mode) } }),
    );
  const markPermission = (permission: KinMailPermission, mode: KinConnectionToolMode) => {
    const modes = kinMailModes(tools, permission, mode);
    if (modes.length === 0) return;
    void run("permissions", `mail:${permission}`, "change that", () =>
      setModes({ environmentId, input: { ...ref, modes } }),
    );
  };
  const signInNeeded =
    connection.auth === "oauth" &&
    (connection.state === "needs_sign_in" || connection.needsSignInToSend === true);
  const notFine = status.tone === "error" || status.tone === "attention";

  const toolRows = rows.map((row) => {
    const copy = mail ? kinToolCopy(row) : { title: row.title, line: null };
    return (
      <KinSettingsRow
        key={row.name}
        title={copy.title}
        detail={
          row.change !== null
            ? COPY.changedDetail
            : (copy.line ?? (row.openWeb ? COPY.openWeb : undefined))
        }
        status={
          row.state === "changed" ? (
            <KinSettingsStatus tone="attention">{COPY.changedShort}</KinSettingsStatus>
          ) : null
        }
        {...(row.change === null
          ? {
              control: (
                <KinSettingsChoice
                  label={copy.title}
                  value={row.mode}
                  options={row.modes.map((mode) => ({
                    value: mode,
                    label: kinMailModeLabel(mode),
                  }))}
                  disabled={save.busy !== null}
                  onChange={(mode) => void markTool(row, mode)}
                />
              ),
            }
          : { onOpen: () => setLooking(row), openLabel: `${COPY.lookAt}: ${copy.title}` })}
      />
    );
  });

  return (
    <KinSettingsPage
      purpose={
        connection.paused
          ? COPY.pausedDetail
          : mail || connection.url === null
            ? undefined
            : connection.urlHost
      }
    >
      {notFine || waiting !== null ? (
        <KinSettingsSection title={status.label}>
          {notFine ? (
            <KinSettingsRow
              wrap
              title={signInNeeded ? MAIL.signInLapsed : status.detail}
              control={
                signInNeeded && waiting === null ? (
                  <Button
                    size="sm"
                    disabled={save.busy !== null}
                    onClick={() => void signInAgain()}
                  >
                    {COPY.signInAgain}
                  </Button>
                ) : changed.length > 1 ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={save.busy !== null}
                    onClick={() =>
                      void run("tools", "accept", "allow the changes", () =>
                        accept({ environmentId, input: kinAcceptAll(ref, connection, rows) }),
                      )
                    }
                  >
                    {COPY.acceptAll}
                  </Button>
                ) : null
              }
            />
          ) : null}
          {waiting === null ? null : (
            <div className="px-4 py-3">
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
            </div>
          )}
        </KinSettingsSection>
      ) : null}

      {mail ? (
        <KinSettingsSection
          title={MAIL.agentsMay}
          description={MAIL.accountDetail}
          problem={problemAt("permissions")}
        >
          {detail === null ? (
            <KinSettingsLoading rows={3} />
          ) : (
            KIN_MAIL_PERMISSIONS.map((one) => {
              const value = kinMailAccountValue(tools, one.permission);
              if (value === null) return null;
              return (
                <KinSettingsRow
                  key={one.permission}
                  wrap
                  title={one.title}
                  detail={
                    props.differs(one.permission, tools)
                      ? KIN_SETTINGS_COPY.differs("account")
                      : undefined
                  }
                  control={
                    <KinSettingsChoice
                      label={one.title}
                      value={value === "mixed" ? null : value}
                      options={one.options}
                      disabled={save.busy !== null}
                      onChange={(mode) => markPermission(one.permission, mode)}
                    />
                  }
                />
              );
            })
          )}
        </KinSettingsSection>
      ) : null}

      <KinSettingsSection title={MAIL.accountSection(mail)} problem={problemAt("account")}>
        <KinSettingsRow
          title={MAIL.nameTitle}
          detail={connection.label}
          openLabel={COPY.renameTitle}
          onOpen={() => setEditing("rename")}
        />
        {connection.kind === "builtin" ? (
          <KinSettingsRow
            title={MAIL.noteTitle}
            detail={connection.note ?? MAIL.noteNone}
            openLabel={COPY.noteTitle}
            onOpen={() => setEditing("note")}
          />
        ) : null}
        {(connection.sendAs ?? []).length === 0 ? null : (
          <KinSettingsRow
            title={MAIL.sendsFromTitle}
            detail={(connection.sendAs ?? [])
              .map((one) => (one.name === null ? one.address : `${one.name} <${one.address}>`))
              .join(", ")}
          />
        )}
        {connection.auth === "key" ? (
          <KinSettingsRow
            title={COPY.keyLabel}
            detail={MAIL.keyDetail}
            openLabel={COPY.replaceKeyTitle}
            onOpen={() => setEditing("key")}
          />
        ) : null}
        {connection.auth === "oauth" && !signInNeeded ? (
          <KinSettingsRow
            title={MAIL.signInTitle}
            detail={MAIL.signInDetail}
            control={
              <Button
                size="sm"
                variant="outline"
                disabled={save.busy !== null || waiting !== null}
                onClick={() => void signInAgain()}
              >
                {COPY.signInAgain}
              </Button>
            }
          />
        ) : null}
        <KinSettingsRow
          title={COPY.reachTitle}
          detail={COPY.reachShort}
          control={
            <Switch
              aria-label={COPY.reachTitle}
              checked={connection.reach === "closed"}
              disabled={save.busy !== null}
              onCheckedChange={(checked) =>
                void run("account", "reach", "change that", () =>
                  setReach({
                    environmentId,
                    input: { ...ref, reach: checked ? "closed" : "open" },
                  }),
                )
              }
            />
          }
        />
      </KinSettingsSection>

      <KinSettingsSection
        {...(mail ? {} : { title: COPY.toolsTitle })}
        problem={problemAt("tools")}
      >
        {mail ? (
          <KinSettingsRow
            title={MAIL.eachTool}
            detail={
              detail === null
                ? undefined
                : MAIL.eachToolDetail(rows.filter((row) => row.on).length, rows.length)
            }
            status={
              changed.length === 0 ? null : (
                <KinSettingsStatus tone="attention">{COPY.changedShort}</KinSettingsStatus>
              )
            }
            control={
              <Button
                size="xs"
                variant="outline"
                aria-expanded={toolsOpen}
                onClick={() => setToolsOpen(!toolsOpen)}
              >
                {toolsOpen ? MAIL.hide : MAIL.show}
              </Button>
            }
          />
        ) : null}
        {mail && !toolsOpen ? null : detail === null ? (
          <KinSettingsLoading rows={4} />
        ) : rows.length === 0 ? (
          <KinSettingsEmpty>{COPY.noTools}</KinSettingsEmpty>
        ) : (
          <>
            {suggested.length > 0 ? (
              <KinSettingsRow
                title={COPY.suggested}
                detail={COPY.suggestedDetail}
                control={
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={save.busy !== null}
                    onClick={() =>
                      void run("tools", "suggested", "turn those on", () =>
                        setModes({ environmentId, input: { ...ref, modes: suggested } }),
                      )
                    }
                  >
                    {MAIL.turnOn(suggested.length)}
                  </Button>
                }
              />
            ) : null}
            {toolRows}
            <KinSettingsRow
              title={COPY.refresh}
              detail={MAIL.refreshDetail}
              control={
                <Button
                  size="xs"
                  variant="outline"
                  disabled={save.busy !== null}
                  onClick={() =>
                    void run("tools", "refresh", "check for changes", () =>
                      refresh({ environmentId, input: ref }),
                    )
                  }
                >
                  {save.busy === "refresh" ? COPY.refreshing : MAIL.check}
                </Button>
              }
            />
          </>
        )}
      </KinSettingsSection>

      <KinSettingsSection title={COPY.callsTitle}>
        {calls === null ? (
          AsyncResult.isFailure(callsResult) ? (
            <KinSettingsEmpty>{MAIL.callsFailed}</KinSettingsEmpty>
          ) : (
            <KinSettingsLoading rows={2} />
          )
        ) : calls.calls.length === 0 ? (
          <KinSettingsEmpty>{COPY.noCalls}</KinSettingsEmpty>
        ) : (
          calls.calls.map((call) => {
            const line = kinUseRow(call, new Date(nowMs), rows);
            return <KinSettingsRow key={line.key} title={line.title} detail={line.detail} />;
          })
        )}
      </KinSettingsSection>

      <KinSettingsSection title={MAIL.pauseOrRemove} problem={problemAt("end")}>
        <KinSettingsRow
          title={connection.paused ? MAIL.resumeTitle : MAIL.pauseTitle}
          detail={connection.paused ? MAIL.pausedDetail : MAIL.pauseDetail}
          control={
            <Button
              size="sm"
              variant="outline"
              disabled={save.busy !== null}
              onClick={() =>
                void run("end", "pause", connection.paused ? "resume it" : "pause it", () =>
                  update({ environmentId, input: { ...ref, paused: !connection.paused } }),
                )
              }
            >
              {connection.paused ? COPY.resume : COPY.pause}
            </Button>
          }
        />
        <KinSettingsRow
          title={mail ? MAIL.removeAccount : MAIL.removeService}
          detail={MAIL.removeRowDetail}
          control={
            <Button
              size="sm"
              variant="destructive-outline"
              disabled={save.busy !== null}
              onClick={() => setConfirming(true)}
            >
              {COPY.removeConfirm}
            </Button>
          }
        />
      </KinSettingsSection>

      {editing === null ? null : (
        <EditDialog
          editing={editing}
          value={editing === "note" ? (connection.note ?? "") : connection.label}
          onClose={() => setEditing(null)}
          onSave={async (value) => {
            const text = value.trim();
            const ok = await save.run(
              editing,
              editing === "rename"
                ? "Couldn't rename it."
                : editing === "note"
                  ? "Couldn't save the note."
                  : "Couldn't replace the key.",
              () =>
                editing === "rename"
                  ? update({ environmentId, input: { ...ref, label: text } })
                  : editing === "note"
                    ? update({ environmentId, input: { ...ref, note: text === "" ? null : text } })
                    : setKey({ environmentId, input: { ...ref, key: makeKey(text) } }),
            );
            reload();
            if (ok) setEditing(null);
            return ok;
          }}
          problem={save.problem}
        />
      )}
      {looking === null ? null : (
        <ToolChangeDialog
          row={looking}
          title={mail ? kinToolCopy(looking).title : looking.title}
          busy={save.busy !== null}
          problem={save.problem}
          onClose={() => setLooking(null)}
          onAccept={async () => {
            const ok = await save.run(`accept:${looking.name}`, "Couldn't allow it.", () =>
              accept({
                environmentId,
                input: { ...ref, tools: [{ tool: looking.name, digest: looking.digest }] },
              }),
            );
            reload();
            if (ok) setLooking(null);
          }}
        />
      )}
      <KinConfirm
        ask={
          confirming
            ? {
                title: COPY.removeTitle(address),
                detail: mail ? MAIL.removeAccountDetail : COPY.removeDetail,
                action: COPY.removeConfirm,
                destructive: true,
              }
            : null
        }
        onConfirm={() => {
          setPlace("end");
          setAside(null);
          void props.actions.remove(connection.connectionId).then((outcome) => {
            if (outcome.ok) props.onRemoved();
            else setAside(outcome.problem);
          });
        }}
        onClose={() => setConfirming(false)}
      />
    </KinSettingsPage>
  );
}

/** Rename, the account's note, or a new key: one field, saved on its button. */
function EditDialog(props: {
  readonly editing: Editing;
  readonly value: string;
  readonly problem: string | null;
  readonly onSave: (value: string) => Promise<boolean>;
  readonly onClose: () => void;
}) {
  const rename = props.editing === "rename";
  const note = props.editing === "note";
  const [value, setValue] = useState(rename || note ? props.value : "");
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const max = rename ? 80 : note ? 200 : 4096;
  const notReady =
    !note && value.trim() === ""
      ? rename
        ? MAIL.nameNeeded
        : MAIL.keyNeeded
      : value.trim().length > max
        ? MAIL.tooLong
        : null;
  return (
    <KinSettingsFormDialog
      title={rename ? COPY.renameTitle : note ? COPY.noteTitle : COPY.replaceKeyTitle}
      description={rename ? undefined : note ? COPY.noteHint : COPY.replaceKeyDetail}
      submitLabel={rename ? MAIL.saveName : note ? MAIL.saveNote : COPY.replaceKey}
      busy={busy}
      notReady={notReady}
      problem={tried ? props.problem : null}
      onSubmit={() => {
        setBusy(true);
        setTried(true);
        void props.onSave(value).then(() => setBusy(false));
      }}
      onClose={props.onClose}
    >
      <KinSettingsField
        label={rename ? COPY.nameLabel : note ? COPY.noteLabel : COPY.keyLabel}
        help={rename || note ? undefined : MAIL.keyHint}
      >
        {(ids) => (
          <Input
            id={ids.control}
            type={rename || note ? "text" : "password"}
            value={value}
            maxLength={max}
            placeholder={
              rename ? COPY.namePlaceholder : note ? COPY.notePlaceholder : COPY.keyPlaceholder
            }
            autoComplete="off"
            spellCheck={false}
            autoFocus
            onChange={(event) => setValue(event.target.value)}
          />
        )}
      </KinSettingsField>
    </KinSettingsFormDialog>
  );
}

/** A tool the service changed: what it said before and now, then Allow the new version. */
function ToolChangeDialog(props: {
  readonly row: KinToolRow;
  readonly title: string;
  readonly busy: boolean;
  readonly problem: string | null;
  readonly onAccept: () => Promise<void>;
  readonly onClose: () => void;
}) {
  const change = props.row.change;
  return (
    <KinSettingsFormDialog
      title={props.title}
      description={COPY.changedDetail}
      submitLabel={COPY.accept}
      busy={props.busy}
      problem={props.problem}
      onSubmit={() => void props.onAccept()}
      onClose={props.onClose}
    >
      {change === null ? null : (
        <div className="flex flex-col gap-3 text-sm">
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">{MAIL.before}</span>
            <p className="whitespace-pre-line text-muted-foreground">
              {change.before ?? MAIL.noDescription}
            </p>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">{MAIL.now}</span>
            <p className="whitespace-pre-line text-foreground">
              {change.after ?? MAIL.noDescription}
            </p>
          </div>
          {change.inputsChanged ? <p className="text-xs">{COPY.inputsChanged}</p> : null}
          {change.labelsChanged ? <p className="text-xs">{COPY.describedChanged}</p> : null}
        </div>
      )}
    </KinSettingsFormDialog>
  );
}
