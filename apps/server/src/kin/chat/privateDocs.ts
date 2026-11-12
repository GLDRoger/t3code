import {
  KIN_DOC_CARD,
  KinDocCardState,
  type KinMessage,
  type KinMessageRef,
  type KinOrgId,
  type KinPersonId,
  type KinWidget,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { isOrgOwner } from "../lead/orgState.ts";
import { sensitiveNow } from "../work/recordRows.ts";

/**
 * A doc pointed at or shown in a chat keeps the titles it had then. Whether it is sensitive is
 * read from the doc each time someone other than the owner sees it, so a doc labelled since
 * shows them only this.
 */
export const PRIVATE_DOC = "a private document";

const decodeCard = Schema.decodeUnknownOption(KinDocCardState);

/** Which of `keys` are docs of this org that are sensitive now. */
export const sensitiveDocs = Effect.fn("KinPrivateDocs.sensitive")(function* (
  orgId: KinOrgId,
  keys: ReadonlyArray<string>,
) {
  if (keys.length === 0) return new Set<string>();
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ key: string }>`SELECT r.key FROM kin_records r
    WHERE r.org_id = ${orgId} AND r.register_id = 'docs' AND r.key IN ${sql.in([...new Set(keys)])}
      AND ${sensitiveNow(sql)} ORDER BY r.key`;
  return new Set(rows.map((row) => row.key));
});

/** A reference to a now-sensitive doc as others see it: no title, no section. */
const privateRef = (ref: KinMessageRef): KinMessageRef => ({
  _tag: "doc",
  key: ref.key,
  version: ref.version,
  section: null,
  title: PRIVATE_DOC,
  sectionTitle: null,
});

const cardOf = (widget: KinWidget) =>
  widget.type === KIN_DOC_CARD ? Option.getOrUndefined(decodeCard(widget.state)) : undefined;

/**
 * Messages and cards as `viewer` may see them: the org owner and agents see docs as they are;
 * anyone else sees a doc that is sensitive now as a private document.
 */
export const docsForViewer = Effect.fn("KinPrivateDocs.forViewer")(function* (
  orgId: KinOrgId,
  viewer: { readonly personId: KinPersonId } | undefined,
  page: {
    readonly messages: ReadonlyArray<KinMessage>;
    readonly widgets: ReadonlyArray<KinWidget>;
  },
) {
  const keys = [
    ...page.messages.flatMap((message) => (message.refs ?? []).map((ref) => ref.key)),
    ...page.widgets.flatMap((widget) => {
      const card = cardOf(widget);
      return card === undefined ? [] : [card.key];
    }),
  ];
  if (keys.length === 0 || viewer === undefined || (yield* isOrgOwner(orgId, viewer.personId)))
    return page;
  const hidden = yield* sensitiveDocs(orgId, keys);
  if (hidden.size === 0) return page;
  return {
    messages: page.messages.map((message) =>
      message.refs?.some((ref) => hidden.has(ref.key)) === true
        ? {
            ...message,
            refs: message.refs.map((ref) => (hidden.has(ref.key) ? privateRef(ref) : ref)),
          }
        : message,
    ),
    widgets: page.widgets.map((widget) => {
      const card = cardOf(widget);
      return card === undefined || !hidden.has(card.key)
        ? widget
        : {
            ...widget,
            state: {
              ...card,
              title: PRIVATE_DOC,
              change: { ...card.change, summary: "" },
            } satisfies KinDocCardState,
          };
    }),
  };
});
