import { useAtomValue } from "@effect/atom-react";
import { kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import {
  KIN_TASKS_KEY_LABEL_MAX,
  KIN_TASKS_KEYS_COPY,
  kinTasksKeyGuide,
  kinTasksKeyLabelCheck,
  kinTasksKeyMade,
  kinTasksKeyMakeBlocked,
  kinTasksKeyRemoveCopy,
  kinTasksKeyRows,
  type KinTasksKeyRow,
} from "@t3tools/client-runtime/kin/kinTasksKeys";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  KinOrgId,
  KinPersonId,
  KinTasksKeysIssueResult,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { CheckIcon, CopyIcon, PlusIcon } from "lucide-react";
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
import { Textarea } from "../components/ui/textarea";
import { namedClipboardTarget, useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { usePreparedConnection } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import { KinConfirm } from "./KinConfirm";
import { kinClient } from "./kinClient";
import {
  KinSettingsEmpty,
  KinSettingsLoadFailed,
  KinSettingsLoading,
  KinSettingsRow,
  KinSettingsSection,
  KinSettingsStatus,
} from "./settings/KinSettingsLayout";

interface KinTasksKeysTarget {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly personId: KinPersonId;
}

/**
 * A person's coding agent keys on their profile. Their own: list, make one, remove. The owner
 * level on someone else's: list and remove only. The host decides both.
 */
export function KinTasksKeysSection(
  props: KinTasksKeysTarget & {
    /** Null on your own profile; the holder's name on someone else's. */
    readonly holder: string | null;
  },
) {
  const { environmentId, orgId, personId, holder } = props;
  const query = kinClient.tasksKeys({ environmentId, input: { orgId, personId } });
  const result = useAtomValue(query);
  const canMake = useAtomValue(kinClient.tasksKeyIssue.permissionAtom(environmentId));
  const canRemove = useAtomValue(kinClient.tasksKeyRevoke.permissionAtom(environmentId));
  const revoke = useAtomCommand(kinClient.tasksKeyRevoke, { reportFailure: false });
  // Shown gone at once; the host's next read is the authority.
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [asking, setAsking] = useState<KinTasksKeyRow | null>(null);
  const [making, setMaking] = useState(false);
  const [shown, setShown] = useState(false);
  const [guiding, setGuiding] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const connection = Option.getOrNull(usePreparedConnection(environmentId));
  const listed = Option.getOrNull(AsyncResult.value(result));
  const keys = listed?.keys ?? null;
  const live = keys?.filter((key) => !removed.has(key.sessionId)) ?? null;
  const rows = live === null ? null : kinTasksKeyRows(live);
  const blocked = live === null ? null : kinTasksKeyMakeBlocked(live.length);
  const refresh = () => appAtomRegistry.refresh(query);
  const removal = asking === null ? null : kinTasksKeyRemoveCopy(asking.label, holder);
  const guide =
    holder === null && listed !== null
      ? kinTasksKeyGuide({
          origin: listed.origin,
          httpBaseUrl: connection?.httpBaseUrl ?? null,
          device: "browser",
        })
      : undefined;

  const remove = async (row: KinTasksKeyRow) => {
    setProblem(null);
    setRemoved((held) => new Set(held).add(row.sessionId));
    const outcome = await revoke({ environmentId, input: { orgId, sessionId: row.sessionId } });
    if (!AsyncResult.isSuccess(outcome)) {
      setRemoved((held) => {
        const next = new Set(held);
        next.delete(row.sessionId);
        return next;
      });
      setProblem(
        kinFailureText(squashAtomCommandFailure(outcome), KIN_TASKS_KEYS_COPY.removeFailed, {
          gone: KIN_TASKS_KEYS_COPY.removeGone,
        }),
      );
    }
    refresh();
  };

  const hasKeys = rows !== null && rows.length > 0;
  // Someone else's keys show only once they have some.
  if (holder !== null && !hasKeys) return null;
  // Most people never use one, so your own section stays folded until you have a key or ask.
  const folded = holder === null && !hasKeys && !shown;
  const mayMake = holder === null && canMake;

  return (
    <KinSettingsSection
      title={KIN_TASKS_KEYS_COPY.title}
      description={
        folded
          ? undefined
          : (blocked ??
            (holder === null ? KIN_TASKS_KEYS_COPY.intro : KIN_TASKS_KEYS_COPY.theirsIntro(holder)))
      }
      action={
        folded || !mayMake ? undefined : (
          <Button
            size="xs"
            variant="outline"
            disabled={blocked !== null || rows === null}
            onClick={() => setMaking(true)}
          >
            <PlusIcon />
            {KIN_TASKS_KEYS_COPY.make}
          </Button>
        )
      }
      problem={problem}
    >
      {folded ? (
        <KinSettingsRow
          title={KIN_TASKS_KEYS_COPY.foldedTitle}
          detail={KIN_TASKS_KEYS_COPY.foldedDetail}
          control={
            <Button size="xs" variant="outline" onClick={() => setShown(true)}>
              {KIN_TASKS_KEYS_COPY.show}
            </Button>
          }
        />
      ) : (
        <>
          {guide === undefined ? null : (
            <KinSettingsRow
              title={KIN_TASKS_KEYS_COPY.setupHow}
              detail={KIN_TASKS_KEYS_COPY.setupDetail}
              status={
                guide === null ? (
                  <KinSettingsStatus tone="attention">
                    {KIN_TASKS_KEYS_COPY.addressMissing}
                  </KinSettingsStatus>
                ) : null
              }
              onOpen={() => setGuiding(true)}
            />
          )}
          {rows === null ? (
            AsyncResult.isFailure(result) ? (
              <KinSettingsLoadFailed onRetry={refresh}>
                {KIN_TASKS_KEYS_COPY.loadFailed}
              </KinSettingsLoadFailed>
            ) : (
              <KinSettingsLoading rows={1} />
            )
          ) : rows.length === 0 ? (
            <KinSettingsEmpty>{KIN_TASKS_KEYS_COPY.none}</KinSettingsEmpty>
          ) : (
            rows.map((row) => (
              <KinSettingsRow
                key={row.sessionId}
                title={row.label}
                detail={row.line}
                control={
                  canRemove && row.canRemove ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-label={`${KIN_TASKS_KEYS_COPY.remove} ${row.label}`}
                      onClick={() => setAsking(row)}
                    >
                      {KIN_TASKS_KEYS_COPY.remove}
                    </Button>
                  ) : null
                }
              />
            ))
          )}
        </>
      )}
      {guiding && guide !== undefined ? (
        <KinTasksKeyGuide
          guide={guide}
          onMake={
            mayMake && rows?.length === 0 && blocked === null
              ? () => {
                  setGuiding(false);
                  setMaking(true);
                }
              : null
          }
          onClose={() => setGuiding(false)}
        />
      ) : null}
      {making ? (
        <KinTasksKeyDialog
          environmentId={environmentId}
          orgId={orgId}
          onMade={refresh}
          onClose={() => setMaking(false)}
        />
      ) : null}
      <KinConfirm
        ask={
          asking === null || removal === null
            ? null
            : {
                title: removal.title,
                detail: removal.detail,
                action: removal.confirm,
                destructive: true,
              }
        }
        onConfirm={() => {
          if (asking !== null) void remove(asking);
        }}
        onClose={() => setAsking(null)}
      />
    </KinSettingsSection>
  );
}

/** Asks for the key's name, then shows the key once. The secret lives in this dialog's state only. */
function KinTasksKeyDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly onMade: () => void;
  readonly onClose: () => void;
}) {
  const issue = useAtomCommand(kinClient.tasksKeyIssue, { reportFailure: false });
  const [made, setMade] = useState<KinTasksKeysIssueResult | null>(null);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const labelId = useId();
  const checked = kinTasksKeyLabelCheck(label);

  const make = async () => {
    if (!checked.ok || busy) return;
    setBusy(true);
    setProblem(null);
    const outcome = await issue({
      environmentId: props.environmentId,
      input: { orgId: props.orgId, label: checked.label },
    });
    setBusy(false);
    if (AsyncResult.isSuccess(outcome)) {
      setMade(outcome.value);
      props.onMade();
    } else
      setProblem(kinFailureText(squashAtomCommandFailure(outcome), KIN_TASKS_KEYS_COPY.makeFailed));
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) props.onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        {made === null ? (
          <form
            className="contents"
            onSubmit={(event) => {
              event.preventDefault();
              void make();
            }}
          >
            <DialogHeader>
              <DialogTitle>{KIN_TASKS_KEYS_COPY.makeTitle}</DialogTitle>
              <DialogDescription>{KIN_TASKS_KEYS_COPY.can}</DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={labelId}>{KIN_TASKS_KEYS_COPY.labelLabel}</Label>
                  <Input
                    id={labelId}
                    value={label}
                    maxLength={KIN_TASKS_KEY_LABEL_MAX}
                    autoComplete="off"
                    autoFocus
                    onChange={(event) => setLabel(event.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">{KIN_TASKS_KEYS_COPY.labelHint}</p>
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
              <Button type="submit" disabled={!checked.ok || busy} aria-busy={busy}>
                {KIN_TASKS_KEYS_COPY.create}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <KinTasksKeyOnce
            made={made}
            environmentId={props.environmentId}
            onClose={props.onClose}
          />
        )}
      </DialogPopup>
    </Dialog>
  );
}

function KinTasksKeyOnce(props: {
  readonly made: KinTasksKeysIssueResult;
  readonly environmentId: EnvironmentId;
  readonly onClose: () => void;
}) {
  const connection = Option.getOrNull(usePreparedConnection(props.environmentId));
  const panel =
    connection === null
      ? null
      : kinTasksKeyMade({
          key: props.made.key,
          secret: props.made.secret,
          origin: props.made.origin,
          httpBaseUrl: connection.httpBaseUrl,
          device: "browser",
        });
  return (
    <>
      <DialogHeader>
        <DialogTitle>{KIN_TASKS_KEYS_COPY.madeTitle(props.made.key.label)}</DialogTitle>
        <DialogDescription>{KIN_TASKS_KEYS_COPY.once}</DialogDescription>
      </DialogHeader>
      <DialogPanel>
        {panel === null ? (
          <Alert variant="error">
            <AlertDescription>{KIN_TASKS_KEYS_COPY.dropped}</AlertDescription>
          </Alert>
        ) : (
          <div className="flex flex-col gap-4">
            {panel.lines.slice(1).map((line) => (
              <p key={line} className="text-sm text-muted-foreground">
                {line}
              </p>
            ))}
            <CopyField label={KIN_TASKS_KEYS_COPY.keyLabel} value={panel.secret} rows={2} />
            <CopyField label={KIN_TASKS_KEYS_COPY.addressLabel} value={panel.address} rows={1} />
            {panel.addressNote === null ? null : (
              <Alert variant="warning">
                <AlertDescription>{panel.addressNote}</AlertDescription>
              </Alert>
            )}
            <h3 className="text-sm font-medium text-foreground">
              {KIN_TASKS_KEYS_COPY.setupTitle}
            </h3>
            {panel.setups.map((setup) => (
              <CopyField
                key={setup.agent}
                label={setup.agent}
                hint={setup.where}
                value={setup.text}
                rows={Math.min(10, setup.text.split("\n").length + 1)}
              />
            ))}
          </div>
        )}
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" onClick={props.onClose}>
          {KIN_TASKS_KEYS_COPY.done}
        </Button>
      </DialogFooter>
    </>
  );
}

/** Where a key goes and what to paste, opened from your own section. */
function KinTasksKeyGuide(props: {
  readonly guide: ReturnType<typeof kinTasksKeyGuide>;
  /** The next step for someone with no key yet; null when they have one or can't make one. */
  readonly onMake: (() => void) | null;
  readonly onClose: () => void;
}) {
  const { guide } = props;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{KIN_TASKS_KEYS_COPY.setupTitle}</DialogTitle>
          <DialogDescription>{KIN_TASKS_KEYS_COPY.standIn}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {guide === null ? (
            <Alert variant="error">
              <AlertDescription>{KIN_TASKS_KEYS_COPY.addressUnknown}</AlertDescription>
            </Alert>
          ) : (
            <div className="flex flex-col gap-4">
              <CopyField label={KIN_TASKS_KEYS_COPY.addressLabel} value={guide.address} rows={1} />
              {guide.addressNote === null ? null : (
                <Alert variant="warning">
                  <AlertDescription>{guide.addressNote}</AlertDescription>
                </Alert>
              )}
              {guide.setups.map((setup) => (
                <CopyField
                  key={setup.agent}
                  label={setup.agent}
                  hint={setup.where}
                  value={setup.text}
                  rows={Math.min(10, setup.text.split("\n").length + 1)}
                />
              ))}
              <p className="text-sm text-muted-foreground">{KIN_TASKS_KEYS_COPY.check}</p>
            </div>
          )}
        </DialogPanel>
        <DialogFooter>
          {props.onMake === null ? null : (
            <Button variant="outline" onClick={props.onMake}>
              {KIN_TASKS_KEYS_COPY.makeTitle}
            </Button>
          )}
          <Button onClick={props.onClose}>{KIN_TASKS_KEYS_COPY.done}</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function CopyField(props: {
  readonly label: string;
  readonly hint?: string;
  readonly value: string;
  readonly rows: number;
}) {
  const id = useId();
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: namedClipboardTarget(props.label),
  });
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id}>{props.label}</Label>
        <Button
          size="xs"
          variant="outline"
          aria-label={`${KIN_TASKS_KEYS_COPY.copy} ${props.label}`}
          onClick={() => copyToClipboard(props.value, undefined)}
        >
          {isCopied ? <CheckIcon /> : <CopyIcon />}
          {isCopied ? KIN_TASKS_KEYS_COPY.copied : KIN_TASKS_KEYS_COPY.copy}
        </Button>
      </div>
      {props.hint === undefined ? null : (
        <p className="text-xs text-muted-foreground">{props.hint}</p>
      )}
      <Textarea
        id={id}
        readOnly
        rows={props.rows}
        value={props.value}
        onFocus={(event) => event.currentTarget.select()}
      />
    </div>
  );
}
