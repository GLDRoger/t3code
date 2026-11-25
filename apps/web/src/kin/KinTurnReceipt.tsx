import { useAtomValue } from "@effect/atom-react";
import { KIN_AGENT_CHANGES } from "@t3tools/client-runtime/kin/kinAgentPage";
import { kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import {
  kinTurnReceiptOpen,
  KIN_TURN_RECEIPT_LABEL,
  kinTurnReceiptRows,
  kinTurnReceiptTarget,
  type KinTurnReceiptRow,
} from "@t3tools/client-runtime/kin/kinTurnReceipt";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  KinOrgId,
  type EnvironmentId,
  type KinMessageLink,
  type KinTurnChanges,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover";
import { useAtomCommand } from "../state/use-atom-command";
import { kinClient } from "./kinClient";
import { kinRecordPlace } from "./kinPlaces";

/** "Changed W-25 and W-26" under an agent's reply; a click lists each change with its Undo. */
export function KinTurnReceipt(props: {
  readonly line: string;
  readonly turnChanges: KinTurnChanges | undefined;
  readonly links: ReadonlyArray<KinMessageLink> | undefined;
  readonly environmentId: EnvironmentId;
  readonly orgId: string;
  readonly connected: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={kinTurnReceiptOpen(props.line)}
            className="max-w-full truncate rounded-md px-1 text-left text-xs text-muted-foreground tabular-nums outline-none ring-ring hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset"
          />
        }
      >
        {props.line}
      </PopoverTrigger>
      <PopoverPopup width="md" padding="compact" align="start" touchBackdrop>
        <KinTurnReceiptList {...props} onOpenEntry={() => setOpen(false)} />
      </PopoverPopup>
    </Popover>
  );
}

// Mounted only while the list is open, so a reply's line costs no command or atom subscription.
function KinTurnReceiptList(props: {
  readonly turnChanges: KinTurnChanges | undefined;
  readonly links: ReadonlyArray<KinMessageLink> | undefined;
  readonly environmentId: EnvironmentId;
  readonly orgId: string;
  readonly connected: boolean;
  readonly onOpenEntry: () => void;
}) {
  const { environmentId } = props;
  const orgId = KinOrgId.make(props.orgId);
  const undo = useAtomCommand(kinClient.agentUndoChange, { reportFailure: false });
  const canUndo = useAtomValue(kinClient.agentUndoChange.permissionAtom(environmentId));
  const [busy, setBusy] = useState<string | null>(null);
  const [refused, setRefused] = useState<{ readonly id: string; readonly text: string } | null>(
    null,
  );
  const { rows, more } = kinTurnReceiptRows(props.turnChanges);
  // The refreshed reply redraws the row; nothing here patches it.
  const run = async (row: KinTurnReceiptRow) => {
    setBusy(row.id);
    setRefused(null);
    const outcome = await undo({
      environmentId,
      input: { orgId, agentId: row.change.agentId, seq: row.change.seq },
    });
    setBusy(null);
    if (AsyncResult.isFailure(outcome))
      setRefused({
        id: row.id,
        text: kinFailureText(squashAtomCommandFailure(outcome), KIN_AGENT_CHANGES.failed),
      });
  };
  return (
    <ul aria-label={KIN_TURN_RECEIPT_LABEL} className="flex flex-col">
      {rows.map((row) => {
        const place = kinRecordPlace(kinTurnReceiptTarget(row, props.links));
        const undone = row.undo === "undone";
        return (
          <li key={row.id} className="flex items-start gap-2 py-1.5">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <Link
                to={place.to}
                params={{ environmentId, orgId: props.orgId }}
                search={place.search}
                onClick={props.onOpenEntry}
                className="flex min-w-0 items-baseline gap-1.5 rounded-sm text-sm outline-none ring-ring hover:underline focus-visible:ring-2 focus-visible:ring-inset"
              >
                <span className="shrink-0 text-muted-foreground tabular-nums">{row.key}</span>
                <span className="truncate text-foreground">{row.title}</span>
              </Link>
              <span className="text-xs text-muted-foreground">
                {undone ? `${row.what} · ${KIN_AGENT_CHANGES.undone}` : row.what}
              </span>
              {refused?.id === row.id ? (
                <span role="status" className="text-xs text-muted-foreground">
                  {refused.text}
                </span>
              ) : null}
            </div>
            {row.undo === "undo" && canUndo ? (
              <div className="shrink-0">
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy !== null || !props.connected}
                  aria-busy={busy === row.id}
                  aria-label={`${KIN_AGENT_CHANGES.undo} ${row.key}: ${row.what}`}
                  onClick={() => void run(row)}
                >
                  {busy === row.id ? KIN_AGENT_CHANGES.undoing : KIN_AGENT_CHANGES.undo}
                </Button>
              </div>
            ) : null}
          </li>
        );
      })}
      {more === null ? null : <li className="py-1.5 text-xs text-muted-foreground">{more}</li>}
    </ul>
  );
}
