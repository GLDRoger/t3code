import type { KinDocsSubscribeInput } from "@t3tools/contracts";
import * as Stream from "effect/Stream";

import { subscribe } from "../rpc/index.ts";
import { resubscribeWhenKinReturns, retryWhileKinUnavailable } from "./kinStreams.ts";
import { KIN_WORK_NOTHING_NAMED, kinWorkNote, type KinWorkLive } from "./kinWorkStream.ts";

/** Docs as the host last described them: its change number, and which docs it named lately. */
export type KinDocsLive = Pick<KinWorkLive, "seq" | "changed" | "unnamed">;

export const KIN_DOCS_LABEL = "kin:docs";

/**
 * The host's change numbers for docs. A list or an open doc read at a lower one is behind and
 * reads again; nothing is read here. Fails only when the host refuses this viewer.
 */
export function kinDocsLiveStream(input: KinDocsSubscribeInput) {
  return Stream.suspend(() => {
    let named = KIN_WORK_NOTHING_NAMED;
    return resubscribeWhenKinReturns(
      retryWhileKinUnavailable(subscribe("kin.docs.subscribe", input)),
      Stream.empty,
      Stream.empty,
    ).pipe(
      Stream.map((event): KinDocsLive => {
        named = kinWorkNote(named, event);
        return {
          seq: named.latest ?? event.seq,
          changed: named.changed,
          unnamed: named.unnamed,
        };
      }),
    );
  });
}
