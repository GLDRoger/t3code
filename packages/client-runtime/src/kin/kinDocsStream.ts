import {
  type KinDocListRow,
  type KinDocRows,
  type KinDocsSubscribeInput,
  kinApplyDocsEvent,
  kinDocRowsStart,
  kinPatchDocsPage,
} from "@t3tools/contracts";
import * as Stream from "effect/Stream";

import { subscribe } from "../rpc/index.ts";
import { KIN_DOCS_DEFAULT_FILTER, type KinDocsFilter, kinDocsSameFilter } from "./kinDocs.ts";
import { resubscribeWhenKinReturns, retryWhileKinUnavailable } from "./kinStreams.ts";
import type { KinPagedListState } from "./kinWorkList.ts";
import { KIN_WORK_NOTHING_NAMED, kinWorkNote, type KinWorkLive } from "./kinWorkStream.ts";

/**
 * Docs as the host last described them: its change number, which docs it named lately, and the
 * rows it sent for the Docs list (`kinPatchDocsPage`); rows stay empty from an older host.
 */
export type KinDocsLive = Pick<KinWorkLive, "seq" | "changed" | "unnamed"> & {
  readonly rows: KinDocRows | null;
};

export const KIN_DOCS_LABEL = "kin:docs";

let kinDocsFolds = 0;
const KIN_DOCS_FOLD_EPOCHS = 1_000_000;

/**
 * The host's change numbers for docs, and each changed doc as the Docs list shows it. A list or an
 * open doc read at a lower number is behind; the list catches up from the rows, anything else
 * reads again. Fails only when the host refuses this viewer.
 */
export function kinDocsLiveStream(input: KinDocsSubscribeInput) {
  return Stream.suspend(() => {
    let named = KIN_WORK_NOTHING_NAMED;
    let rows: KinDocRows | null = null;
    // Each fold numbers its own epochs, so a page held from an earlier one never patches from this.
    const epoch = (kinDocsFolds += KIN_DOCS_FOLD_EPOCHS);
    return resubscribeWhenKinReturns(
      retryWhileKinUnavailable(subscribe("kin.docs.subscribe", { ...input, acceptRows: true })),
      Stream.empty,
      Stream.empty,
    ).pipe(
      Stream.map((event): KinDocsLive => {
        named = kinWorkNote(named, event);
        rows = rows === null ? kinDocRowsStart(event.seq, epoch) : kinApplyDocsEvent(rows, event);
        return {
          seq: named.latest ?? event.seq,
          changed: named.changed,
          unnamed: named.unnamed,
          rows,
        };
      }),
    );
  });
}

/**
 * Keeps the unfiltered Docs list current from the stream's rows (`KinDocsLive.rows`): `read` wraps
 * each page read, `catchUp` patches the held page. Any other filter reads again.
 */
export function kinDocsPageFollower(rows: () => KinDocRows | null) {
  /** The fold the page on screen was read beside; null when there was none. */
  let epoch: number | null = null;
  return {
    read: <A>(page: { readonly cursor?: string }, run: () => Promise<A>) => {
      if (page.cursor === undefined) epoch = rows()?.epoch ?? null;
      return run();
    },
    catchUp: (state: KinPagedListState<KinDocsFilter, KinDocListRow>) => {
      const held = rows();
      if (
        held === null ||
        state.seq === null ||
        state.total === null ||
        !kinDocsSameFilter(state.filter, KIN_DOCS_DEFAULT_FILTER)
      )
        return null;
      const patched = kinPatchDocsPage(
        { docs: state.records, total: state.total, more: state.more, seq: state.seq, epoch },
        held,
      );
      return patched === null
        ? null
        : { records: patched.docs, total: patched.total, more: patched.more, moved: patched.moved };
    },
  };
}
