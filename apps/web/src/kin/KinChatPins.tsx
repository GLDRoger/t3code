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
import { useLayoutEffect, useRef, useState } from "react";

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
  readonly onOpen: (opens: NonNullable<KinPinView["opens"]>) => void;
}) {
  const { view } = props.item;
  if (view.opens !== null) {
    const target = view.opens;
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

type PendingFocus =
  | {
      readonly kind: "unpin";
      readonly pinId: KinChatPinId;
      readonly removedPinId: KinChatPinId;
    }
  | { readonly kind: "trigger" };

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
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const unpinRefs = useRef<Map<KinChatPinId, HTMLButtonElement>>(new Map());
  const pendingFocusRef = useRef<PendingFocus | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves DOM focus onto the next Unpin button or strip trigger on commit before Base UI restores focus to the popup
  useLayoutEffect(() => {
    const target = pendingFocusRef.current;
    if (target === null) return;
    if (target.kind === "trigger") {
      if (popoverOpen || unpinning !== null) return;
      pendingFocusRef.current = null;
      triggerRef.current?.focus();
      return;
    }
    const removed = !pins.some((pin) => pin.pinId === target.removedPinId);
    if (!removed && unpinning !== null) return;
    const button = unpinRefs.current.get(target.pinId);
    if (button !== undefined) {
      pendingFocusRef.current = null;
      button.focus();
    }
  }, [unpinning, popoverOpen, pins]);

  const writable = kinChatMayWritePins(members, personId);
  const strip = kinPinStrip(pins, views, {
    canUnpin: actions.canUnpin,
    writable,
    hasMoney: destinations.includes("money"),
  });
  if (!supported || strip.count === 0 || strip.first === null) return null;

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

  const unpin = async (pinId: KinChatPinId, byKeyboard: boolean) => {
    if (unpinning !== null) return;
    const unpinnable = strip.items
      .filter((entry) => entry.canUnpin)
      .map((entry) => entry.pin.pinId);
    const at = unpinnable.indexOf(pinId);
    const fallbackId = unpinnable[at + 1] ?? (at > 0 ? unpinnable[at - 1] : undefined);
    // Record the target before the RPC so a synchronous pins refresh moves focus on the same commit.
    if (byKeyboard) {
      pendingFocusRef.current =
        fallbackId !== undefined
          ? { kind: "unpin", pinId: fallbackId, removedPinId: pinId }
          : { kind: "trigger" };
    }
    setUnpinning(pinId);
    setProblem(null);
    const outcome = await actions.unpin({ chatId, pinId });
    if (AsyncResult.isFailure(outcome)) {
      pendingFocusRef.current = null;
      setUnpinning(null);
      setProblem({
        pinId,
        text: kinPinFailureText(squashAtomCommandFailure(outcome), "unpin"),
      });
      return;
    }
    const remaining = outcome.value.pins;
    const nextUnpinId =
      fallbackId !== undefined && remaining.some((pin) => pin.pinId === fallbackId)
        ? fallbackId
        : remaining.find((pin) => pin._tag !== "hidden")?.pinId;
    if (remaining.length === 0 || nextUnpinId === undefined) {
      if (byKeyboard) pendingFocusRef.current = { kind: "trigger" };
      setPopoverOpen(false);
    } else if (byKeyboard && pendingFocusRef.current !== null) {
      pendingFocusRef.current = { kind: "unpin", pinId: nextUnpinId, removedPinId: pinId };
    }
    setUnpinning(null);
  };

  const first = strip.first;
  const firstOpens = first.view.opens;
  const showTrigger = strip.more !== null || strip.canUnpinAny;

  return (
    <div
      role="region"
      aria-label={KIN_PINS_COPY.stripLabel}
      className="flex min-w-0 items-center gap-2 border-b border-border px-4 py-1.5"
    >
      <div className="hidden min-w-0 flex-1 items-center gap-2 md:flex">
        {strip.items.map((item) => (
          <PinChip key={item.pin.pinId} item={item} onOpen={openSource} />
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
                  ref={triggerRef}
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
                  const opens = item.view.opens;
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
                              ref={(node) => {
                                if (node === null) unpinRefs.current.delete(item.pin.pinId);
                                else unpinRefs.current.set(item.pin.pinId, node);
                              }}
                              size="xs"
                              variant="ghost"
                              aria-disabled={unpinning !== null || undefined}
                              aria-label={KIN_PINS_COPY.unpinLabel(item.view.title)}
                              onClick={(event) => void unpin(item.pin.pinId, event.detail === 0)}
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
