import { useAtomValue } from "@effect/atom-react";
import type {
  KinChatId,
  KinChatPin,
  KinChatPinInput,
  KinChatPinsResult,
  KinChatUnpinInput,
  KinOwnerTimeZone,
  KinPeopleProfilesResult,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useState } from "react";

import { kinNextDayStart, kinPinView, type KinPinZones } from "../kinPins.ts";
import type { KinScreenTarget } from "../kinScreenReads.ts";
import { kinWorkDueZone } from "../kinWork.ts";
import type { KinHookApp } from "./kinHookApp.ts";

type ChatTarget = KinScreenTarget & { readonly chatId: KinChatId };
type Foreground = (update: () => void) => () => void;

const localNow = () => DateTime.toDateUtc(DateTime.nowUnsafe());

const noPins: ReadonlyArray<KinChatPin> = [];
const noRead = Atom.make<AsyncResult.AsyncResult<KinChatPinsResult, unknown>>(
  AsyncResult.initial(),
);
const noZone = Atom.make<AsyncResult.AsyncResult<KinOwnerTimeZone, unknown>>(AsyncResult.initial());
const noProfiles = Atom.make<AsyncResult.AsyncResult<KinPeopleProfilesResult, unknown>>(
  AsyncResult.initial(),
);

function dueTime(pin: KinChatPin) {
  if (
    pin._tag === "hidden" ||
    pin._tag === "gone" ||
    pin.state === "done" ||
    pin.state === "dropped"
  )
    return null;
  if (pin._tag === "task" && pin.dueAt !== null) return { allDay: pin.dueAllDay };
  if (pin._tag === "project" && pin.targetAt !== null) return { allDay: pin.targetAllDay };
  return null;
}

export function makeKinPinsHooks<R, ER>({
  kinClient,
  registry,
  useAtomCommand,
}: KinHookApp<R, ER>) {
  function useKinPinZones(
    { environmentId, orgId }: KinScreenTarget,
    personId: string | null,
    enabled = true,
  ): KinPinZones {
    const supported = useAtomValue(
      kinClient.chatPinsSupported({ environmentId, input: { orgId } }),
    );
    const active = enabled && supported;
    const zoneResult = useAtomValue(
      active ? kinClient.workZone({ environmentId, input: { orgId } }) : noZone,
    );
    const profilesResult = useAtomValue(
      active && personId !== null
        ? kinClient.profiles({ environmentId, input: { orgId } })
        : noProfiles,
    );
    const zone = Option.getOrNull(AsyncResult.value(zoneResult))?.timeZone ?? null;
    const readerZone =
      personId === null
        ? null
        : (Option.getOrNull(AsyncResult.value(profilesResult))?.profiles.find(
            (profile) => profile.personId === personId,
          )?.timeZone ?? null);
    return { zone, readerZone };
  }

  function useKinPins(
    { environmentId, orgId, chatId }: ChatTarget,
    names: KinPinZones,
    options: { readonly enabled?: boolean; readonly subscribeForeground?: Foreground } = {},
  ) {
    const { enabled = true, subscribeForeground } = options;
    const supported = useAtomValue(
      kinClient.chatPinsSupported({ environmentId, input: { orgId } }),
    );
    const read = useAtomValue(
      enabled && supported
        ? kinClient.chatPins({ environmentId, input: { orgId, chatId } })
        : noRead,
    );
    const pins = Option.getOrUndefined(AsyncResult.value(read))?.pins ?? noPins;
    const company = pins.some((pin) => dueTime(pin)?.allDay === true);
    const reader = pins.some((pin) => dueTime(pin)?.allDay === false);
    const companyZone = kinWorkDueZone(true, names);
    const readerZone = kinWorkDueZone(false, names);
    const [now, setNow] = useState(localNow);
    // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- syncs only with local midnight and app foreground
    useEffect(() => {
      if (!company && !reader) return;
      const zones = [...(company ? [companyZone] : []), ...(reader ? [readerZone] : [])];
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const update = () => {
        if (timeout !== undefined) clearTimeout(timeout);
        const at = localNow();
        setNow(at);
        const next = kinNextDayStart(at, zones);
        // @effect-diagnostics-next-line globalTimers:off -- React owns and cancels this one midnight timer.
        if (next !== null) timeout = setTimeout(update, next.getTime() - at.getTime());
      };
      update();
      const stop = subscribeForeground?.(update);
      return () => {
        if (timeout !== undefined) clearTimeout(timeout);
        stop?.();
      };
    }, [company, reader, companyZone, readerZone, subscribeForeground]);
    return { supported, pins, views: pins.map((pin) => kinPinView(pin, now, names)) };
  }

  function useKinPinActions({ environmentId, orgId }: KinScreenTarget) {
    const supported = useAtomValue(
      kinClient.chatPinsSupported({ environmentId, input: { orgId } }),
    );
    const canPin = useAtomValue(kinClient.chatPin.permissionAtom(environmentId));
    const canUnpin = useAtomValue(kinClient.chatUnpin.permissionAtom(environmentId));
    const pin = useAtomCommand(kinClient.chatPin, { reportFailure: false });
    const unpin = useAtomCommand(kinClient.chatUnpin, { reportFailure: false });
    return {
      supported,
      canPin: supported && canPin,
      canUnpin: supported && canUnpin,
      pin: async (input: Omit<KinChatPinInput, "orgId">) => {
        const outcome = await pin({ environmentId, input: { ...input, orgId } });
        if (AsyncResult.isSuccess(outcome))
          registry.refresh(
            kinClient.chatPins({ environmentId, input: { orgId, chatId: input.chatId } }),
          );
        return outcome;
      },
      unpin: async (input: Omit<KinChatUnpinInput, "orgId">) => {
        const outcome = await unpin({ environmentId, input: { ...input, orgId } });
        if (AsyncResult.isSuccess(outcome))
          registry.refresh(
            kinClient.chatPins({ environmentId, input: { orgId, chatId: input.chatId } }),
          );
        return outcome;
      },
    };
  }

  return { useKinPinZones, useKinPins, useKinPinActions };
}
