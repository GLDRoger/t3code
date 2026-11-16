import { useAtomValue } from "@effect/atom-react";
import { kinListSend } from "@t3tools/client-runtime/kin/kinLists";
import {
  KIN_NOTES,
  kinDocLabelAction,
  kinNotesVersions,
} from "@t3tools/client-runtime/kin/kinTemplates";
import type { KinWorkNames } from "@t3tools/client-runtime/kin/kinWork";
import { KIN_WORK_COPY } from "@t3tools/client-runtime/kin/kinWorkChanges";
import type { KinDocDetail, KinRecordDetail } from "@t3tools/contracts";
import { RotateCcwIcon } from "lucide-react";
import { useState } from "react";

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
import { useAtomCommand } from "../state/use-atom-command";
import { kinClient } from "./kinClient";
import { kinHostConnected } from "./useKinHost";
import type { KinWorkTarget } from "./useKinWork";

/** A yes-or-cancel question before a change the owner should mean. */
export function KinConfirm(props: {
  readonly ask: {
    readonly title: string;
    readonly detail: string;
    readonly action: string;
    readonly destructive?: boolean;
  } | null;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}) {
  const { ask } = props;
  return (
    <AlertDialog
      open={ask !== null}
      onOpenChange={(next) => {
        if (!next) props.onClose();
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{ask?.title}</AlertDialogTitle>
          <AlertDialogDescription>{ask?.detail}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>
            {KIN_WORK_COPY.cancel}
          </AlertDialogClose>
          <Button
            variant={ask?.destructive === true ? "destructive" : "default"}
            onClick={() => {
              props.onClose();
              props.onConfirm();
            }}
          >
            {ask?.action}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

/** Raising or lowering a doc's private label from its menu: the item, its question, and any refusal. */
export function useKinDocLabel(target: KinWorkTarget, doc: KinDocDetail) {
  const allowed = useAtomValue(kinClient.docLabel.permissionAtom(target.environmentId));
  const send = useAtomCommand(kinClient.docLabel, { reportFailure: false });
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const action = allowed ? kinDocLabelAction(doc) : null;
  const confirm = async () => {
    if (action === null) return;
    setProblem(null);
    const sent = await kinListSend({
      online: () => kinHostConnected(target.environmentId),
      send: () =>
        send({
          environmentId: target.environmentId,
          input: { orgId: target.orgId, key: doc.key, sensitive: action.sensitive },
        }),
    });
    if (!sent.ok) setProblem(sent.problem);
  };
  return {
    action,
    problem,
    dismiss: () => setProblem(null),
    ask: () => setAsking(true),
    dialog: (
      <KinConfirm
        ask={asking && action !== null ? { ...action, action: action.label } : null}
        onConfirm={() => void confirm()}
        onClose={() => setAsking(false)}
      />
    ),
  };
}

/** Earlier versions of an entry's notes, folded away, each with who wrote it and a way back. */
export function KinNotesVersions(props: {
  readonly item: KinRecordDetail;
  readonly names: KinWorkNames;
  readonly now: Date;
  readonly busy: boolean;
  /** Null where this device may not change the entry. */
  readonly onRestore: ((notes: string) => void) | null;
}) {
  const versions = kinNotesVersions(props.item, props.names, props.now);
  const [restoring, setRestoring] = useState<string | null>(null);
  if (versions.length === 0) return null;
  return (
    <details className="group text-sm">
      <summary className="cursor-pointer rounded-sm text-xs text-muted-foreground outline-none ring-ring select-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset">
        {KIN_NOTES.earlier(versions.length)}
      </summary>
      <ol className="mt-2 flex flex-col divide-y divide-border/60">
        {versions.map((version) => (
          <li key={version.key} className="flex flex-col gap-1 py-2">
            <span className="text-xs text-muted-foreground">{version.by ?? KIN_NOTES.first}</span>
            <p className="line-clamp-4 whitespace-pre-wrap text-foreground">{version.text}</p>
            {props.onRestore === null ? null : (
              <Button
                size="xs"
                variant="outline"
                className="self-start"
                disabled={props.busy}
                onClick={() => setRestoring(version.text)}
              >
                <RotateCcwIcon />
                {KIN_NOTES.restore}
              </Button>
            )}
          </li>
        ))}
      </ol>
      <KinConfirm
        ask={
          restoring === null
            ? null
            : {
                title: KIN_NOTES.restoreTitle,
                detail: KIN_NOTES.restoreDetail,
                action: KIN_NOTES.restore,
              }
        }
        onConfirm={() => {
          if (restoring !== null) props.onRestore?.(restoring);
        }}
        onClose={() => setRestoring(null)}
      />
    </details>
  );
}
