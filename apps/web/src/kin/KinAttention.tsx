import {
  KIN_ATTENTION,
  kinAsideOf,
  kinAttention,
  kinAttentionMenu,
  kinGotItCall,
  kinNotNowCall,
  kinPickDayCopy,
  kinSetAsideDays,
  runKinAttentionCall,
  type KinAsideRow,
  type KinAttentionMore,
  type KinAttentionOpen,
  type KinAttentionRow,
  type KinAttentionScope,
} from "@t3tools/client-runtime/kin/kinAttention";
import type { KinWorkNames } from "@t3tools/client-runtime/kin/kinWork";
import type { KinDay, KinPulseRead, KinRecordKey } from "@t3tools/contracts";
import { CircleAlertIcon, ClockIcon, EllipsisIcon } from "lucide-react";
import { useState } from "react";

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
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../components/ui/menu";
import { cn } from "../lib/utils";
import { KinWorkSection } from "./KinWorkParts";
import { useNowMinuteMs } from "./useKinClock";
import { useKinAskAbout, useKinAttention, useKinAttentionHandle } from "./useKinAttention";
import { useKinWorkZone, type KinWorkTarget } from "./useKinWork";

/** Everyone Kin can name, agents and people, for "has it until". */
export const kinAttentionNames = (names: KinWorkNames) =>
  new Map([...names.agents, ...names.people]);

type Handler = ReturnType<typeof useKinAttentionHandle>;

/** "Pick a day": a day it comes back on, or until someone lifts it when the row has a record. */
function KinSetAsideDialog(props: {
  readonly title: string;
  readonly open: boolean;
  readonly allowUntilLifted: boolean;
  readonly zone: string | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSave: (until?: KinDay) => void;
}) {
  const days = kinSetAsideDays(new Date(useNowMinuteMs()), props.zone);
  const copy = kinPickDayCopy(props.allowUntilLifted);
  const [day, setDay] = useState<string>(days.initial);
  const save = (until?: KinDay) => {
    props.onOpenChange(false);
    props.onSave(until);
  };
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{`${copy.title}: ${props.title}`}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <Input
            type="date"
            aria-label={KIN_ATTENTION.setAsideDay}
            min={days.min}
            value={day}
            onChange={(event) => setDay(event.target.value)}
          />
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={() => props.onOpenChange(false)}>
            {KIN_ATTENTION.cancel}
          </Button>
          {copy.untilLifted === null ? null : (
            <Button variant="outline" onClick={() => save()}>
              {copy.untilLifted}
            </Button>
          )}
          <Button disabled={day < days.min} onClick={() => save(day)}>
            {copy.save}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

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
  const [asideOpen, setAsideOpen] = useState(false);
  const { zone } = useKinWorkZone(props);
  const menu = kinAttentionMenu(row, now, zone);
  const pickDay = menu.later.choices.find((choice) => choice.id === "pick_day")!;
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
        {row.whatsNext === null ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={() => runKinAttentionCall(handler, kinGotItCall(row))}
          >
            {KIN_ATTENTION.gotIt}
          </Button>
        ) : (
          <WhatsNext
            row={row}
            deal={row.whatsNext}
            busy={busy}
            handler={handler}
            onOpen={props.onOpen}
          />
        )}
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={KIN_ATTENTION.menu(row.title)}
                disabled={busy}
              />
            }
          >
            <EllipsisIcon />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuSub>
              <MenuSubTrigger>{menu.later.label}</MenuSubTrigger>
              <MenuSubPopup>
                {menu.later.choices.map((choice) => (
                  <MenuItem
                    key={choice.id}
                    onClick={() => {
                      if (choice.id === "pick_day") setAsideOpen(true);
                      else runKinAttentionCall(handler, choice.call);
                    }}
                  >
                    {choice.label}
                  </MenuItem>
                ))}
              </MenuSubPopup>
            </MenuSub>
            <MenuItem onClick={() => runKinAttentionCall(handler, menu.notNeeded.call)}>
              {menu.notNeeded.label}
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
      <KinSetAsideDialog
        title={row.title}
        open={asideOpen}
        allowUntilLifted={pickDay.allowUntilLifted}
        zone={zone}
        onOpenChange={setAsideOpen}
        onSave={(until) => runKinAttentionCall(handler, pickDay.callForDay(until))}
      />
    </li>
  );
}

/** A deal with no next step: open it to add one, or hold it for two weeks as the person's own. */
function WhatsNext(props: {
  readonly row: KinAttentionRow;
  readonly deal: KinRecordKey;
  readonly busy: boolean;
  readonly handler: Handler;
  readonly onOpen: (open: KinAttentionOpen) => void;
}) {
  const now = new Date(useNowMinuteMs());
  return (
    <>
      <Button
        size="xs"
        variant="outline"
        disabled={props.busy}
        onClick={() => props.onOpen({ type: "record", key: props.deal })}
      >
        {KIN_ATTENTION.whatsNext}
      </Button>
      <Button
        size="xs"
        variant="ghost"
        disabled={props.busy}
        onClick={() => runKinAttentionCall(props.handler, kinNotNowCall(props.row, now))}
      >
        {KIN_ATTENTION.notNow}
      </Button>
    </>
  );
}

/** What someone already has in hand or set aside, folded away, each with its Undo. */
export function KinAttentionHandled(props: {
  readonly rows: ReadonlyArray<KinAttentionRow>;
  readonly asides?: ReadonlyArray<KinAsideRow> | undefined;
  readonly handler: Handler;
}) {
  const [open, setOpen] = useState(false);
  const asides = props.asides ?? [];
  const count = props.rows.length + asides.length;
  if (count === 0) return null;
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
        {`${KIN_ATTENTION.handled} (${count})`}
      </Button>
      {open ? (
        <ul className="flex flex-col">
          {asides.map((row) => (
            <li key={row.id} className="flex items-center gap-2 px-2 py-1">
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm text-muted-foreground">{row.title}</span>
                <span className="text-xs text-muted-foreground">{row.detail}</span>
              </span>
              {row.liftable ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={props.handler.busy === row.record}
                  onClick={() => void props.handler.aside(row.record, "lift")}
                >
                  {KIN_ATTENTION.undo}
                </Button>
              ) : null}
            </li>
          ))}
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

/** "N more … not listed" at the foot of a group: nothing to answer; one about money opens Money. */
export function KinAttentionNotListed(props: {
  readonly lines: ReadonlyArray<KinAttentionMore>;
  readonly onOpen: (open: KinAttentionOpen) => void;
}) {
  if (props.lines.length === 0) return null;
  return (
    <ul className="flex flex-col">
      {props.lines.map((line) => (
        <li key={line.id}>
          {line.open.type === "none" ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">{line.text}</p>
          ) : (
            <Button size="xs" variant="ghost-muted" onClick={() => props.onOpen(line.open)}>
              {line.text}
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * "Needs attention" at the top of a project, a client or Money: only what is about it, and
 * nothing at all when nothing is open or set aside.
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
  const { open, handled, asides, more } = kinAttention(read, {
    scope: props.scope,
    names: kinAttentionNames(props.names),
    now,
  });
  if (open.length === 0 && asides.length === 0) return null;
  return (
    <KinWorkSection title={KIN_ATTENTION.title}>
      {open.length === 0 ? null : (
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
      )}
      <KinAttentionNotListed lines={more} onOpen={props.onOpen} />
      <KinAttentionHandled rows={handled} asides={asides} handler={handler} />
      {handler.problem === null ? null : (
        <p role="alert" className="px-2 text-xs text-destructive-foreground">
          {handler.problem}
        </p>
      )}
    </KinWorkSection>
  );
}

/**
 * One quiet line on a client's, project's, invoice's, quote's or deal's own page while it is set
 * aside, with Undo for whoever may lift it. Nothing when it isn't, or the host can't say.
 */
export function KinAsideNote(
  props: KinWorkTarget & { readonly record: KinRecordKey; readonly names: KinWorkNames },
) {
  const read = useKinAttention(props);
  const handler = useKinAttentionHandle(props);
  const now = new Date(useNowMinuteMs());
  const row = kinAsideOf(read, props.record, { names: kinAttentionNames(props.names), now });
  if (row === null) return null;
  return (
    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <ClockIcon aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0">{row.detail}</span>
      {row.liftable ? (
        <Button
          size="xs"
          variant="ghost"
          disabled={handler.busy === row.record}
          onClick={() => void handler.aside(row.record, "lift")}
        >
          {KIN_ATTENTION.undo}
        </Button>
      ) : null}
      {handler.problem === null ? null : (
        <span role="alert" className="text-destructive-foreground">
          {handler.problem}
        </span>
      )}
    </p>
  );
}
