import type { KinAttachment, KinEvent, KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { shownAsPicture } from "../lead/turn/content.ts";
import { SILENT_REPLY } from "../reply/classify.ts";
import { listDef, PRESETS } from "./registers.ts";

/**
 * A quiet bills turn as its agent reads it: the bills of its event still to read, each file named
 * by the short id `bill_read` takes (never its own name: phone photos share names).
 */
export const billTurn = Effect.fn("KinBills.billTurn")(function* (
  orgId: KinOrgId,
  event: Extract<KinEvent, { readonly _tag: "bills.read" }>,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    sha256: string;
    attachmentId: string;
    name: string;
    fileType: "image" | "file";
    mimeType: string;
    sizeBytes: number;
  }>`SELECT sha256, attachment_id AS "attachmentId", name, file_type AS "fileType",
      mime_type AS "mimeType", size_bytes AS "sizeBytes"
    FROM kin_bill_reads
    WHERE org_id = ${orgId} AND sha256 IN ${sql.in([...event.bills])} AND state = 'reading'
      AND event_id = ${event.eventId}
    ORDER BY sha256`;
  const files = event.bills.flatMap((hash, index) => {
    const row = rows.find((one) => one.sha256 === hash);
    if (row === undefined) return [];
    const id = `B${index + 1}`;
    const extension = row.name.includes(".") ? `.${row.name.split(".").at(-1)}` : "";
    const attachment: KinAttachment = {
      type: row.fileType,
      id: row.attachmentId,
      name: `${id}${extension}`.slice(0, 40),
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
    };
    return [{ id, attachment }];
  });
  if (files.length === 0) return undefined;
  const categories = (yield* listDef(orgId, "expenses"))?.categories ?? PRESETS.expenses.categories;
  return {
    ids: files.map((file) => file.id),
    attachments: files.map((file) => file.attachment),
    text: billTurnText(
      files.map(({ id, attachment }) => ({
        id,
        image: shownAsPicture(attachment),
        name: attachment.name,
      })),
      categories,
    ),
  };
});

/** The turn's one section: which file is which bill, and what to answer. */
export const billTurnText = (
  files: ReadonlyArray<{ readonly id: string; readonly image: boolean; readonly name: string }>,
  categories: ReadonlyArray<string>,
) => {
  let image = 0;
  const named = files.map(({ id, image: isImage, name }) =>
    isImage ? `${id} is image ${++image}` : `${id} is "${name}"`,
  );
  return `Bills someone added to read in the background: ${named.join(", ")}. Answer each with bill_read once, with only what it prints: leave a blank blank, and leave out currency when none is printed. Expenses' categories: ${categories.join(", ")}. Record nothing else, then write exactly ${SILENT_REPLY}.`;
};
