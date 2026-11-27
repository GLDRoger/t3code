import {
  KIN_PINS_COPY,
  kinChatMayWritePins,
  kinPinFailureText,
  kinPinStrip,
  type KinPinItem,
  type KinPinView,
} from "@t3tools/client-runtime/kin/kinPins";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  KinChatId,
  KinChatMember,
  KinChatPinId,
  KinOrgId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { EllipsisIcon, PinIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../components/ui/popover";
import { cn } from "../lib/utils";
import { KIN_PLACE_PATH, kinRecordPlace } from "./kinPlaces";
import { useKinDestinations } from "./useKinPlaces";
import {
  subscribeKinPinsForeground,
  useKinPinActions,
  useKinPins,
  useKinPinZones,
} from "./useKinPins";

function PinChipContent(props: { readonly view: KinPinView }) {
  const { view } = props;
  return (
    <>
      <PinIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
      <span
        className={cn(
          "min-w-0 truncate text-xs font-medium",
          view.tone === "muted" ? "text-muted-foreground" : "text-foreground",
        )}
      >
        {view.title}
      </span>
      {view.line === null ? null : (
        <span
          className={cn(
            "shrink-0 truncate text-xs tabular-nums",
            view.tone === "late" ? "text-destructive-foreground" : "text-muted-foreground",
          )}
        >
          {view.line}
        </span>
      )}
    </>
  );
}

function PinChip(props: {
  readonly item: KinPinItem;
  readonly opens: KinPinView["opens"];
  readonly onOpen: (opens: NonNullable<KinPinView["opens"]>) => void;
}) {
  const { view } = props.item;
  if (props.opens !== null) {
    const target = props.opens;
    return (
      <button
        type="button"
        onClick={() => props.onOpen(target)}
        className="flex min-w-0 max-w-xs flex-1 items-center gap-1.5 rounded-md border border-border/70 bg-card/60 px-2.5 py-1 text-start outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset"
      >
        <PinChipContent view={view} />
      </button>
    );
  }
  return (
    <div className="flex min-w-0 max-w-xs flex-1 items-center gap-1.5 rounded-md border border-border/50 bg-muted/40 px-2.5 py-1">
      <PinChipContent view={view} />
    </div>
  );
}

/**
 * One-row strip of live pinned cards directly under the chat header.
 * Shows nothing while empty, loading, or on hosts without pins.
 */
export function KinChatPinsStrip(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly chatId: KinChatId;
  readonly personId: string | null;
  readonly members: ReadonlyArray<KinChatMember>;
}) {
  const { environmentId, orgId, chatId, personId, members } = props;
  const navigate = useNavigate();
  const zones = useKinPinZones({ environmentId, orgId }, personId);
  const { supported, pins, views } = useKinPins({ environmentId, orgId, chatId }, zones, {
    subscribeForeground: subscribeKinPinsForeground,
  });
  const actions = useKinPinActions({ environmentId, orgId });
  const { destinations } = useKinDestinations({ environmentId, orgId });
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [unpinning, setUnpinning] = useState<KinChatPinId | null>(null);
  const [problem, setProblem] = useState<{
    readonly pinId: KinChatPinId;
    readonly text: string;
  } | null>(null);

  const writable = kinChatMayWritePins(members, personId);
  const strip = kinPinStrip(pins, views, { canUnpin: actions.canUnpin, writable });
  if (!supported || strip.count === 0 || strip.first === null) return null;

  // Goals live inside Money on web; a reader without Money gets the glance and no dead end.
  const opensFor = (view: KinPinView) =>
    view.opens?.kind === "goal" && !destinations.includes("money") ? null : view.opens;

  const openSource = (opens: NonNullable<KinPinView["opens"]>) => {
    setPopoverOpen(false);
    if (opens.kind === "goal") {
      void navigate({ to: KIN_PLACE_PATH.money, params: { environmentId, orgId } });
      return;
    }
    void navigate({
      ...kinRecordPlace({ kind: opens.kind, key: opens.key }),
      params: { environmentId, orgId },
    });
  };

  const unpin = async (pinId: KinChatPinId) => {
    if (unpinning !== null) return;
    setUnpinning(pinId);
    setProblem(null);
    const outcome = await actions.unpin({ chatId, pinId });
    setUnpinning(null);
    if (AsyncResult.isFailure(outcome)) {
      setProblem({
        pinId,
        text: kinPinFailureText(squashAtomCommandFailure(outcome), "unpin"),
      });
      return;
    }
    if (outcome.value.pins.length === 0) setPopoverOpen(false);
  };

  const first = strip.first;
  const firstOpens = opensFor(first.view);
  const showTrigger = strip.more !== null || strip.canUnpinAny;

  return (
    <div
      role="region"
      aria-label={KIN_PINS_COPY.stripLabel}
      className="flex min-w-0 items-center gap-2 border-b border-border px-4 py-1.5"
    >
      <div className="hidden min-w-0 flex-1 items-center gap-2 md:flex">
        {strip.items.map((item) => (
          <PinChip
            key={item.pin.pinId}
            item={item}
            opens={opensFor(item.view)}
            onOpen={openSource}
          />
        ))}
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-2 md:hidden">
        {firstOpens !== null ? (
          <button
            type="button"
            onClick={() => openSource(firstOpens)}
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-0.5 text-start outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset"
          >
            <PinChipContent view={first.view} />
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-1.5 py-0.5">
            <PinChipContent view={first.view} />
          </div>
        )}
      </div>
      {!showTrigger ? null : (
        <div className={cn("shrink-0", !strip.canUnpinAny && "md:hidden")}>
          <Popover
            open={popoverOpen}
            onOpenChange={(next) => {
              setPopoverOpen(next);
              if (!next) setProblem(null);
            }}
          >
            <PopoverTrigger
              render={
                <Button
                  size={strip.more === null ? "icon-xs" : "xs"}
                  variant="ghost"
                  aria-label={KIN_PINS_COPY.openListLabel(strip.count)}
                />
              }
            >
              {strip.more === null ? (
                <EllipsisIcon />
              ) : (
                <>
                  <span className="md:hidden">{strip.more}</span>
                  <span className="hidden md:inline-flex">
                    <EllipsisIcon />
                  </span>
                </>
              )}
            </PopoverTrigger>
            <PopoverPopup align="end" width="md" padding="compact">
              <div className="px-1 pb-2">
                <PopoverTitle>{KIN_PINS_COPY.sheetTitle}</PopoverTitle>
              </div>
              <ul className="flex flex-col divide-y divide-border/60">
                {strip.items.map((item) => {
                  const opens = opensFor(item.view);
                  const rowProblem = problem?.pinId === item.pin.pinId ? problem.text : null;
                  const body = (
                    <>
                      <span
                        className={cn(
                          "block truncate text-sm font-medium",
                          item.view.tone === "muted" ? "text-muted-foreground" : "text-foreground",
                        )}
                      >
                        {item.view.title}
                      </span>
                      {item.view.line === null ? null : (
                        <span
                          className={cn(
                            "block text-xs tabular-nums",
                            item.view.tone === "late"
                              ? "text-destructive-foreground"
                              : "text-muted-foreground",
                          )}
                        >
                          {item.view.line}
                        </span>
                      )}
                    </>
                  );
                  return (
                    <li
                      key={item.pin.pinId}
                      className="flex flex-col gap-1 py-2 first:pt-1 last:pb-1"
                    >
                      <div className="flex items-center gap-2">
                        {opens !== null ? (
                          <button
                            type="button"
                            onClick={() => openSource(opens)}
                            className="min-w-0 flex-1 rounded-md px-1 py-0.5 text-start outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset"
                          >
                            {body}
                          </button>
                        ) : (
                          <div className="min-w-0 flex-1 px-1 py-0.5">{body}</div>
                        )}
                        {item.canUnpin ? (
                          <div className="shrink-0">
                            <Button
                              size="xs"
                              variant="ghost"
                              disabled={unpinning !== null}
                              aria-label={KIN_PINS_COPY.unpinLabel(item.view.title)}
                              onClick={() => void unpin(item.pin.pinId)}
                            >
                              {KIN_PINS_COPY.unpinFromChat}
                            </Button>
                          </div>
                        ) : null}
                      </div>
                      {rowProblem === null ? null : (
                        <p role="alert" className="px-1 text-xs text-destructive-foreground">
                          {rowProblem}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            </PopoverPopup>
          </Popover>
        </div>
      )}
    </div>
  );
}
