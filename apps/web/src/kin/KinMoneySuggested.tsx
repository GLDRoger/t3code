import { KIN_MONEY, type KinMoneySuggestionView } from "@t3tools/client-runtime/kin/kinMoney";
import { kinListSend } from "@t3tools/client-runtime/kin/kinLists";
import { KIN_WORK_COPY } from "@t3tools/client-runtime/kin/kinWorkChanges";
import type { KinRecordKey } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useAtomCommand } from "../state/use-atom-command";
import { kinClient } from "./kinClient";
import { KinWorkSection } from "./KinWorkParts";
import { kinHostConnected } from "./useKinHost";
import type { KinWorkTarget } from "./useKinWork";

/**
 * Keep or decline money an agent suggested, with the same Keep and Not needed a suggested task
 * has. The host refuses anyone below a co-owner; `allowed` hides the taps where it would.
 */
function useKinKeepSuggestion(target: KinWorkTarget, onChanged: () => void) {
  const { environmentId, orgId } = target;
  const allowed = useAtomValue(kinClient.workConfirm.permissionAtom(environmentId));
  const confirm = useAtomCommand(kinClient.workConfirm, { reportFailure: false });
  const decline = useAtomCommand(kinClient.workDecline, { reportFailure: false });
  const [busy, setBusy] = useState<KinRecordKey | null>(null);
  const [problem, setProblem] = useState<{ key: KinRecordKey; text: string } | null>(null);
  const act = async (row: { readonly key: KinRecordKey; readonly rev: number }, keep: boolean) => {
    setBusy(row.key);
    setProblem(null);
    const input = { orgId, key: row.key, rev: row.rev };
    const sent = await kinListSend({
      online: () => kinHostConnected(environmentId),
      send: () => (keep ? confirm : decline)({ environmentId, input }),
    });
    setBusy(null);
    if (sent.ok) onChanged();
    else setProblem({ key: row.key, text: sent.problem });
  };
  return { allowed, busy, problem, act };
}

function KeepButtons(props: {
  readonly title: string;
  readonly busy: boolean;
  readonly onKeep: () => void;
  readonly onDecline: () => void;
}) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      <Button
        size="xs"
        variant="ghost"
        disabled={props.busy}
        aria-label={`${KIN_WORK_COPY.decline}: ${props.title}`}
        onClick={props.onDecline}
      >
        {KIN_WORK_COPY.decline}
      </Button>
      <Button
        size="xs"
        variant="outline"
        disabled={props.busy}
        aria-label={`${KIN_WORK_COPY.keep}: ${props.title}`}
        onClick={props.onKeep}
      >
        {KIN_WORK_COPY.keep}
      </Button>
    </span>
  );
}

/** Money an agent suggested that no figure counts yet, each kept or declined in one tap. */
export function KinMoneySuggested(
  props: KinWorkTarget & {
    readonly rows: ReadonlyArray<KinMoneySuggestionView>;
    readonly onOpenKey: (key: KinRecordKey) => void;
    readonly onChanged: () => void;
  },
) {
  const keep = useKinKeepSuggestion(props, props.onChanged);
  return (
    <KinWorkSection title={KIN_MONEY.suggested}>
      <p className="px-2 text-xs text-muted-foreground">{KIN_MONEY.suggestedNote}</p>
      <ul className="flex flex-col">
        {props.rows.map((row) => (
          <li key={row.key} className="flex flex-col gap-1">
            <div className="flex items-start gap-2">
              <button
                type="button"
                onClick={() => props.onOpenKey(row.key)}
                className="flex min-w-0 flex-1 items-start gap-3 rounded-md px-2 py-1.5 text-start outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset"
              >
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-sm text-foreground">{row.title}</span>
                  <span className="truncate text-xs text-muted-foreground">{row.line}</span>
                </span>
                {row.amount === null ? null : (
                  <span className="shrink-0 text-sm text-foreground tabular-nums">
                    {row.amount}
                  </span>
                )}
              </button>
              {keep.allowed ? (
                <span className="pt-1">
                  <KeepButtons
                    title={row.title}
                    busy={keep.busy !== null}
                    onKeep={() => void keep.act(row, true)}
                    onDecline={() => void keep.act(row, false)}
                  />
                </span>
              ) : null}
            </div>
            {keep.problem?.key === row.key ? (
              <p role="alert" className="px-2 text-xs text-destructive-foreground">
                {keep.problem.text}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </KinWorkSection>
  );
}

/** On a suggested entry's own page: what it is, and Keep or Not needed beside it. */
export function KinSuggestionKeep(
  props: KinWorkTarget & {
    readonly item: { readonly key: KinRecordKey; readonly rev: number; readonly title: string };
  },
) {
  const { environmentId, orgId, item } = props;
  const keep = useKinKeepSuggestion(props, () =>
    appAtomRegistry.refresh(kinClient.workItem({ environmentId, input: { orgId, key: item.key } })),
  );
  if (!keep.allowed) return null;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm text-muted-foreground">{KIN_MONEY.suggestedNote}</p>
        <KeepButtons
          title={props.item.title}
          busy={keep.busy !== null}
          onKeep={() => void keep.act(props.item, true)}
          onDecline={() => void keep.act(props.item, false)}
        />
      </div>
      {keep.problem === null ? null : (
        <p role="alert" className="text-xs text-destructive-foreground">
          {keep.problem.text}
        </p>
      )}
    </div>
  );
}
