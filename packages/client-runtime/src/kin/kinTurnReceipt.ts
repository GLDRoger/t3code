import type {
  KinMessageLink,
  KinMessageLinkTarget,
  KinTurnChange,
  KinTurnChanges,
} from "@t3tools/contracts";

/** How many entries the line names before "and N more". */
const NAMED = 2;

/**
 * The quiet line under an agent's reply: "Changed W-25, W-26 and 1 more", naming entries and
 * counting the changes about any other. Null when the turn changed nothing, or for a reply from an
 * older host, which has no receipt.
 */
export const KIN_TURN_RECEIPT_LABEL = "What this reply changed";
export const kinTurnReceiptOpen = (line: string) => `${line}. Show the changes`;

export function kinTurnReceiptLine(turn: KinTurnChanges | undefined): string | null {
  if (turn === undefined || turn.count === 0) return null;
  const named = [...new Set(turn.items.map((item) => item.key))].slice(0, NAMED);
  const rest = turn.count - turn.items.filter((item) => named.includes(item.key)).length;
  const list = named.join(rest === 0 ? " and " : ", ");
  return rest === 0 ? `Changed ${list}` : `Changed ${list} and ${rest} more`;
}

export type KinTurnReceiptUndo = "undo" | "undone" | "none";

export interface KinTurnReceiptRow {
  readonly id: string;
  readonly key: string;
  readonly kind: KinTurnChange["kind"];
  /** A contact's client, whose page it opens on. */
  readonly party?: string;
  readonly title: string;
  readonly what: string;
  /** `undo` offers Undo (`kin.lead.undoChange` with `change`); `undone` says it was put back. */
  readonly undo: KinTurnReceiptUndo;
  readonly change: KinTurnChange["change"];
}

/** The list the line opens, oldest first, with what is not listed as a last line of its own. */
export function kinTurnReceiptRows(turn: KinTurnChanges | undefined): {
  readonly rows: ReadonlyArray<KinTurnReceiptRow>;
  readonly more: string | null;
} {
  if (turn === undefined) return { rows: [], more: null };
  return {
    rows: turn.items.map((item) => ({
      id: `${item.change.agentId}:${item.change.seq}`,
      key: item.key,
      kind: item.kind,
      ...(item.party === undefined ? {} : { party: item.party }),
      title: item.title,
      what: item.what,
      undo: item.undone ? "undone" : item.undoable ? "undo" : "none",
      change: item.change,
    })),
    more: turn.more === 0 ? null : `${turn.more} more ${turn.more === 1 ? "change" : "changes"}`,
  };
}

/**
 * Where a row opens: a contact on its client's page, else the kind the change carries, else the
 * reply's own link to that key; an entry neither names (an older host) opens in the task sheet, as
 * attention rows do.
 */
export function kinTurnReceiptTarget(
  row: Pick<KinTurnChange, "key" | "kind" | "party">,
  links: ReadonlyArray<KinMessageLink> | undefined,
): Extract<KinMessageLinkTarget, { readonly _tag: "record" }> {
  if (row.party !== undefined) return { _tag: "record", key: row.party, kind: "client" };
  if (row.kind !== undefined) return { _tag: "record", key: row.key, kind: row.kind };
  for (const link of links ?? [])
    if (link.to._tag === "record" && link.to.key === row.key) return link.to;
  return { _tag: "record", key: row.key, kind: "task" };
}
