import { useAtomValue } from "@effect/atom-react";
import type {
  KinNumberDefinition,
  KinNumbersDefinitionsResult,
  KinNumbersListResult,
  KinRecordKey,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useMemo } from "react";

import { kinOwnerLevelAtom } from "../kinAccess.ts";
import { kinListSend, type KinListOutcome } from "../kinLists.ts";
import {
  KIN_NUMBERS,
  kinNumberDecimal,
  kinNumberLocale,
  kinNumberSave,
  kinNumbersShown,
  kinNumberToday,
  kinNumberWindow,
  type KinNumberDraft,
} from "../kinNumbers.ts";
import type { KinScreenTarget } from "../kinScreenReads.ts";
import { kinWorkReadState } from "../kinWorkForms.ts";
import type { KinHookApp } from "./kinHookApp.ts";

type Read<A> = Atom.Atom<AsyncResult.AsyncResult<A, unknown>>;
const noList: Read<KinNumbersListResult> = Atom.make(AsyncResult.initial());
const noDefinitions: Read<KinNumbersDefinitionsResult> = Atom.make(AsyncResult.initial());
const notOwnerLevel = Atom.make(false);

/** Watched numbers on one app's client: the list, a number's history, typing and the form. */
export function makeKinNumbersHooks<R, ER>(app: KinHookApp<R, ER>) {
  const { kinClient, registry, runtime, useAtomCommand, kinHostConnected, newId } = app;

  /** Today where the company is, from the owner's zone once read. */
  function useKinNumberToday(target: KinScreenTarget, nowMs: number): string {
    const zone = useAtomValue(
      kinClient.workZone({ environmentId: target.environmentId, input: { orgId: target.orgId } }),
    );
    return kinNumberToday(nowMs, Option.getOrNull(AsyncResult.value(zone))?.timeZone ?? null);
  }

  /** The viewer's locale for numbers, worked out once. */
  function useKinNumberLocale(locale?: string) {
    return useMemo(() => kinNumberLocale(locale), [locale]);
  }

  /** The list, live; `enabled` false reads nothing. */
  function useKinNumbers(target: KinScreenTarget, enabled = true) {
    const allowed = useAtomValue(kinClient.numbersRead.permissionAtom(target.environmentId));
    const atom = kinClient.numbers({
      environmentId: target.environmentId,
      input: { orgId: target.orgId },
    });
    const state = kinWorkReadState(useAtomValue(enabled && allowed ? atom : noList));
    const ownerLevel = useAtomValue(kinOwnerLevelAtom(runtime, target.environmentId));
    const canSave = useAtomValue(kinClient.numberSave.permissionAtom(target.environmentId));
    return { state, ownerLevel, canSave, retry: () => registry.refresh(atom) };
  }

  /**
   * Whether the nav offers Numbers: the owner level always; anyone else while the list holds one
   * for them. Null until known.
   */
  function useKinNumbersShown(target: KinScreenTarget | null): boolean | null {
    const ownerLevel = useAtomValue(
      target === null ? notOwnerLevel : kinOwnerLevelAtom(runtime, target.environmentId),
    );
    const allowed = useAtomValue(
      kinClient.numbersRead.permissionAtom(target?.environmentId ?? null),
    );
    const read = useAtomValue(
      target === null || ownerLevel || !allowed
        ? noList
        : kinClient.numbers({ environmentId: target.environmentId, input: { orgId: target.orgId } }),
    );
    if (target === null) return false;
    if (ownerLevel) return true;
    const list = Option.getOrNull(AsyncResult.value(read));
    if (list === null) return AsyncResult.isFailure(read) || !allowed ? false : null;
    return kinNumbersShown({ ownerLevel, count: list.numbers.length });
  }

  /** One number's values over the last year, for its page. */
  function useKinNumberValues(target: KinScreenTarget, number: KinRecordKey, today: string) {
    const window = kinNumberWindow(today);
    const atom = kinClient.numberValues({
      environmentId: target.environmentId,
      input: { orgId: target.orgId, number, ...window },
    });
    const state = kinWorkReadState(useAtomValue(atom));
    return { state, retry: () => registry.refresh(atom) };
  }

  /** How each number is set up, archived ones too; read only for the owner level. */
  function useKinNumberDefinitions(target: KinScreenTarget, enabled: boolean) {
    const allowed = useAtomValue(kinClient.numberSave.permissionAtom(target.environmentId));
    const atom = kinClient.numberDefinitions({
      environmentId: target.environmentId,
      input: { orgId: target.orgId },
    });
    const state = kinWorkReadState(useAtomValue(enabled && allowed ? atom : noDefinitions));
    return { state, retry: () => registry.refresh(atom) };
  }

  /**
   * Records what a person typed as `asOf`'s value: read as an exact decimal first, then sent once.
   * A refusal says what went wrong; the field keeps what was typed.
   */
  function useKinNumberRecord(target: KinScreenTarget) {
    const record = useAtomCommand(kinClient.numberRecord, { reportFailure: false });
    const locale = useKinNumberLocale();
    return async (input: {
      readonly number: KinRecordKey;
      readonly unit: string | undefined;
      readonly typed: string;
      readonly asOf: string;
      readonly clientRequestId: string;
    }): Promise<KinListOutcome<unknown>> => {
      const read = kinNumberDecimal(input.typed, input.unit, locale);
      if (!read.ok) return { ok: false, problem: read.problem, changed: false };
      const outcome = await kinListSend({
        online: () => kinHostConnected(target.environmentId),
        send: () =>
          record({
            environmentId: target.environmentId,
            input: {
              orgId: target.orgId,
              number: input.number,
              value: read.value,
              asOf: input.asOf,
              clientRequestId: input.clientRequestId,
            },
          }),
      });
      if (outcome.ok) {
        registry.refresh(
          kinClient.numbers({ environmentId: target.environmentId, input: { orgId: target.orgId } }),
        );
      }
      return outcome;
    };
  }

  /** Watches, changes, archives or restores a number from the form's draft. */
  function useKinNumberSave(target: KinScreenTarget) {
    const save = useAtomCommand(kinClient.numberSave, { reportFailure: false });
    const locale = useKinNumberLocale();
    return async (input: {
      readonly definition: KinNumberDefinition | null;
      readonly draft: KinNumberDraft;
      readonly clientRequestId: string;
      readonly archived?: boolean;
    }): Promise<KinListOutcome<KinNumberDefinition>> => {
      const checked = kinNumberSave(input.draft, input.definition, locale);
      if (!checked.ok) return { ok: false, problem: checked.problem, changed: false };
      const outcome = await kinListSend({
        online: () => kinHostConnected(target.environmentId),
        send: () =>
          save({
            environmentId: target.environmentId,
            input: {
              ...checked.input,
              ...(input.archived === undefined ? {} : { archived: input.archived }),
              orgId: target.orgId,
              clientRequestId: input.clientRequestId,
            },
          }),
      });
      if (outcome.ok || outcome.changed) {
        const at = { environmentId: target.environmentId, input: { orgId: target.orgId } };
        registry.refresh(kinClient.numbers(at));
        registry.refresh(kinClient.numberDefinitions(at));
      }
      return outcome.ok || outcome.problem !== ""
        ? outcome
        : { ...outcome, problem: KIN_NUMBERS.formFailed };
    };
  }

  return {
    useKinNumberToday,
    useKinNumberLocale,
    useKinNumbers,
    useKinNumbersShown,
    useKinNumberValues,
    useKinNumberDefinitions,
    useKinNumberRecord,
    useKinNumberSave,
    newNumberRequestId: newId,
  };
}
