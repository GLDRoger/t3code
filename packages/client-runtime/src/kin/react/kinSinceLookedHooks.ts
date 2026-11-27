import { useAtomValue } from "@effect/atom-react";
import type {
  KinDocDetail,
  KinProjectPage,
  KinRecordDetail,
  KinRecordId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";

import type { KinScreenTarget } from "../kinScreenReads.ts";
import {
  mergePinnedDocSinceLooked,
  mergePinnedProjectSinceLooked,
  pinEntryLookedAt,
  type KinPinnedDocLook,
  type KinPinnedEntryLook,
  type KinPinnedProjectLook,
} from "../kinSinceLooked.ts";
import type { KinHookApp } from "./kinHookApp.ts";

export interface KinLookedInput {
  readonly recordId: KinRecordId;
  readonly upTo: string;
}

/** Shared visit-pinning and `kin.work.looked` hooks for web and mobile record screens. */
export function makeKinSinceLookedHooks<R, ER>(app: KinHookApp<R, ER>) {
  const { kinClient, useAtomCommand, kinHostConnected } = app;

  /**
   * Advances this person's look mark when they actually see the latest version of a record:
   * only while `visible` is true (never on a background refresh) and at most once per newer `upTo`.
   */
  function useKinRecordLooked(
    target: KinScreenTarget,
    input: KinLookedInput | null,
    visible: boolean,
  ) {
    const { environmentId, orgId } = target;
    const allowed = useAtomValue(kinClient.workLooked.permissionAtom(environmentId));
    const send = useAtomCommand(kinClient.workLooked, { reportFailure: false });
    const sent = useRef<{ readonly key: string; readonly ms: number } | null>(null);
    const inFlight = useRef<{ readonly key: string; readonly ms: number } | null>(null);
    const recordId = input?.recordId ?? null;
    const upTo = input?.upTo ?? null;

    // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- posts the explicit look mark to the host when the person actually views the record
    useEffect(() => {
      if (!visible || !allowed || recordId === null || upTo === null) return;
      if (!kinHostConnected(environmentId)) return;
      const ms = Date.parse(upTo);
      if (Number.isNaN(ms)) return;
      const key = `${environmentId}:${orgId}:${recordId}`;
      if (sent.current !== null && sent.current.key === key && ms <= sent.current.ms) return;
      if (inFlight.current !== null && inFlight.current.key === key && ms <= inFlight.current.ms)
        return;
      inFlight.current = { key, ms };
      void send({ environmentId, input: { orgId, recordId, upTo } }).then((outcome) => {
        if (inFlight.current?.key === key && inFlight.current.ms === ms) inFlight.current = null;
        if (AsyncResult.isSuccess(outcome)) {
          if (sent.current === null || sent.current.key !== key || ms > sent.current.ms) {
            sent.current = { key, ms };
          }
        }
      });
    }, [visible, allowed, environmentId, orgId, recordId, upTo, send]);
  }

  /** Pins an entry's first-render `lookedAt` for the visit so live re-reads never drop the line. */
  function useKinPinnedEntryLook(
    item: Pick<KinRecordDetail, "recordId" | "lookedAt"> | null,
  ): string | null | undefined {
    const [held, setHeld] = useState<KinPinnedEntryLook | null>(null);
    if (item === null) return undefined;
    const next = pinEntryLookedAt(held, item.recordId, item.lookedAt);
    if (next !== held) setHeld(next);
    return next?.lookedAt;
  }

  /** Pins a doc's visit mark and merges any live versions that arrive while the doc stays open. */
  function useKinPinnedDocLook(
    doc: Pick<KinDocDetail, "recordId" | "lookedAt" | "sinceLooked"> | null,
    active: boolean,
  ): KinPinnedDocLook | null {
    const [held, setHeld] = useState<KinPinnedDocLook | null>(null);
    if (!active || doc === null) return null;
    const next = mergePinnedDocSinceLooked(held, doc.recordId, doc.lookedAt, doc.sinceLooked);
    if (next !== held) setHeld(next);
    return next;
  }

  /** Pins a project's visit mark and merges any live changes that arrive while the page stays open. */
  function useKinPinnedProjectLook(
    page: Pick<KinProjectPage, "project" | "lookedAt" | "sinceLooked"> | null,
  ): KinPinnedProjectLook | null {
    const [held, setHeld] = useState<KinPinnedProjectLook | null>(null);
    if (page === null) return null;
    const next = mergePinnedProjectSinceLooked(
      held,
      page.project.recordId,
      page.lookedAt,
      page.sinceLooked,
    );
    if (next !== held) setHeld(next);
    return next;
  }

  return {
    useKinRecordLooked,
    useKinPinnedEntryLook,
    useKinPinnedDocLook,
    useKinPinnedProjectLook,
  };
}
