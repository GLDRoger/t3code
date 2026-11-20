import { useAtomValue } from "@effect/atom-react";
import { kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import {
  KIN_TASKS_KEY_LABEL_MAX,
  KIN_TASKS_KEYS_COPY,
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
import { CheckIcon, CopyIcon } from "lucide-react";
import { useId, useState } from "react";

import { Alert, AlertDescription } from "../components/ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
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
import { kinClient } from "./kinClient";

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
  const [problem, setProblem] = useState<string | null>(null);
  const keys = Option.getOrNull(AsyncResult.value(result))?.keys ?? null;
  const live = keys?.filter((key) => !removed.has(key.sessionId)) ?? null;
  const rows = live === null ? null : kinTasksKeyRows(live);
  const blocked = live === null ? null : kinTasksKeyMakeBlocked(live.length);
  const refresh = () => appAtomRegistry.refresh(query);
  const removal = asking === null ? null : kinTasksKeyRemoveCopy(asking.label, holder);

  const remove = async (row: KinTasksKeyRow) => {
    setAsking(null);
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

  return (
    <section className="flex flex-col gap-2" aria-label={KIN_TASKS_KEYS_COPY.title}>
      <h3 className="text-xs font-medium text-muted-foreground">{KIN_TASKS_KEYS_COPY.title}</h3>
      <p className="text-sm text-muted-foreground">
        {holder === null ? KIN_TASKS_KEYS_COPY.intro : KIN_TASKS_KEYS_COPY.theirsIntro(holder)}
      </p>
      {rows === null ? (
        <p className="text-sm text-muted-foreground">
          {AsyncResult.isFailure(result) ? KIN_TASKS_KEYS_COPY.loadFailed : "Loading…"}
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {holder === null ? KIN_TASKS_KEYS_COPY.none : KIN_TASKS_KEYS_COPY.noneTheirs(holder)}
        </p>
      ) : (
        <ul className="flex flex-col">
          {rows.map((row) => (
            <li
              key={row.sessionId}
              className="flex items-center gap-3 border-b border-border/60 py-2 last:border-b-0"
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-sm font-medium text-foreground">{row.label}</span>
                <span className="text-xs text-muted-foreground">{row.line}</span>
              </span>
              {canRemove && row.canRemove ? (
                <Button
                  size="sm"
                  variant="destructive-outline"
                  aria-label={`${KIN_TASKS_KEYS_COPY.remove} ${row.label}`}
                  onClick={() => setAsking(row)}
                >
                  {KIN_TASKS_KEYS_COPY.remove}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {problem === null ? null : (
        <p role="alert" className="text-sm text-destructive-foreground">
          {problem}
        </p>
      )}
      {holder === null && canMake ? (
        <>
          <Button
            variant="outline"
            className="self-start"
            disabled={blocked !== null || rows === null}
            onClick={() => setMaking(true)}
          >
            {KIN_TASKS_KEYS_COPY.make}
          </Button>
          {blocked === null ? null : <p className="text-xs text-muted-foreground">{blocked}</p>}
        </>
      ) : null}
      {making ? (
        <KinTasksKeyDialog
          environmentId={environmentId}
          orgId={orgId}
          onMade={refresh}
          onClose={() => setMaking(false)}
        />
      ) : null}
      <AlertDialog open={asking !== null} onOpenChange={(open) => !open && setAsking(null)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{removal?.title}</AlertDialogTitle>
            <AlertDialogDescription>{removal?.detail}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button variant="destructive" onClick={() => asking !== null && void remove(asking)}>
              {removal?.confirm}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </section>
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
