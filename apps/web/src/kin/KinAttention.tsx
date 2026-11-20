import {
  KIN_ATTENTION,
  kinAttention,
  kinSnoozeDays,
  type KinAttentionOpen,
  type KinAttentionRow,
  type KinAttentionScope,
} from "@t3tools/client-runtime/kin/kinAttention";
import type { KinWorkNames } from "@t3tools/client-runtime/kin/kinWork";
import type { KinPulseRead } from "@t3tools/contracts";
import { CircleAlertIcon, ClockIcon, EllipsisIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../components/ui/menu";
import { cn } from "../lib/utils";
import { KinWorkSection } from "./KinWorkParts";
import { useNowMinuteMs } from "./useKinClock";
import { useKinAskAbout, useKinAttention, useKinAttentionHandle } from "./useKinAttention";
import type { KinWorkTarget } from "./useKinWork";

/** Everyone Kin can name, agents and people, for "has it until". */
export const kinAttentionNames = (names: KinWorkNames) =>
  new Map([...names.agents, ...names.people]);

type Handler = ReturnType<typeof useKinAttentionHandle>;

/** One row: what, why it matters, and the answers to it. Tapping it opens the thing itself. */
export function KinAttentionItem(
  props: KinWorkTarget & {
    readonly row: KinAttentionRow;
    readonly handler: Handler;
    readonly onOpen: (open: KinAttentionOpen) => void;
  },
) {
  const { row, handler } = props;
  const now = new Date(useNowMinuteMs());
  const asker = useKinAskAbout(props)(row.agentId);
  const busy = handler.busy === row.factKey;
  const opens = row.open.type !== "none";
  const line = row.about === null ? row.detail : `${row.detail.replace(/\.$/, "")} · ${row.about}`;
  const body = (
    <>
      <CircleAlertIcon
        aria-hidden
        className={cn(
          "mt-0.5 size-4 shrink-0",
          row.urgent ? "text-destructive-foreground" : "text-muted-foreground",
        )}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm text-foreground">{row.title}</span>
        <span
          className={cn(
            "line-clamp-2 text-xs wrap-break-word",
            row.urgent ? "text-destructive-foreground" : "text-muted-foreground",
          )}
        >
          {line}
        </span>
      </span>
    </>
  );
  return (
    <li className="flex items-start gap-1 rounded-md hover:bg-accent/60">
      {opens ? (
        <button
          type="button"
          aria-label={`${row.title}, ${line}`}
          onClick={() => props.onOpen(row.open)}
          className="flex min-w-0 flex-1 items-start gap-3 rounded-md px-2 py-1.5 text-start outline-none ring-ring focus-visible:ring-2 focus-visible:ring-inset"
        >
          {body}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-start gap-3 px-2 py-1.5">{body}</div>
      )}
      <div className="flex shrink-0 items-center gap-0.5 py-1 pe-1">
        <Button
          size="xs"
          variant="ghost"
          disabled={busy}
          onClick={() => void handler.send(row.factKey, "got_it")}
        >
          {KIN_ATTENTION.gotIt}
        </Button>
        <Menu>
          <MenuTrigger
            render={
              <Button size="icon-xs" variant="ghost" aria-label="More answers" disabled={busy} />
            }
          >
            <EllipsisIcon />
          </MenuTrigger>
          <MenuPopup align="end">
            {kinSnoozeDays(now).map((choice) => (
              <MenuItem
                key={choice.label}
                onClick={() => void handler.send(row.factKey, "got_it", choice.until)}
              >
                {choice.label}
              </MenuItem>
            ))}
            <MenuItem onClick={() => void handler.send(row.factKey, "not_a_problem")}>
              {KIN_ATTENTION.notAProblem}
            </MenuItem>
            {asker === null ? null : (
              <>
                <MenuSeparator />
                <MenuItem onClick={() => asker.ask(row.askDraft)}>
                  {KIN_ATTENTION.ask(asker.name)}
                </MenuItem>
              </>
            )}
          </MenuPopup>
        </Menu>
      </div>
    </li>
  );
}

/** What someone already has in hand, folded away, each with its Undo. */
export function KinAttentionHandled(props: {
  readonly rows: ReadonlyArray<KinAttentionRow>;
  readonly handler: Handler;
}) {
  const [open, setOpen] = useState(false);
  if (props.rows.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <Button
        size="xs"
        variant="ghost"
        className="self-start"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <ClockIcon />
        {`${KIN_ATTENTION.handled} (${props.rows.length})`}
      </Button>
      {open ? (
        <ul className="flex flex-col">
          {props.rows.map((row) => (
            <li key={row.id} className="flex items-center gap-2 px-2 py-1">
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm text-muted-foreground">{row.title}</span>
                <span className="truncate text-xs text-muted-foreground">{row.handled}</span>
              </span>
              <Button
                size="xs"
                variant="outline"
                disabled={props.handler.busy === row.factKey}
                onClick={() => void props.handler.send(row.factKey, "undo")}
              >
                {KIN_ATTENTION.undo}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * "Needs attention" at the top of a project, a client or Money: only what is about it, and
 * nothing at all when nothing is.
 */
export function KinAttentionSection(
  props: KinWorkTarget & {
    readonly scope: KinAttentionScope;
    readonly names: KinWorkNames;
    readonly onOpen: (open: KinAttentionOpen) => void;
    /** Already read by the screen; else this reads it. */
    readonly read?: KinPulseRead | null;
  },
) {
  const own = useKinAttention(props, props.read === undefined, false, props.scope);
  const read = props.read === undefined ? own : props.read;
  const handler = useKinAttentionHandle(props, props.scope);
  const now = new Date(useNowMinuteMs());
  const { open, handled } = kinAttention(read, {
    scope: props.scope,
    names: kinAttentionNames(props.names),
    now,
  });
  if (open.length === 0) return null;
  return (
    <KinWorkSection title={KIN_ATTENTION.title}>
      <ul className="flex flex-col">
        {open.map((row) => (
          <KinAttentionItem
            key={row.id}
            {...props}
            row={row}
            handler={handler}
            onOpen={props.onOpen}
          />
        ))}
      </ul>
      <KinAttentionHandled rows={handled} handler={handler} />
      {handler.problem === null ? null : (
        <p role="alert" className="px-2 text-xs text-destructive-foreground">
          {handler.problem}
        </p>
      )}
    </KinWorkSection>
  );
}
