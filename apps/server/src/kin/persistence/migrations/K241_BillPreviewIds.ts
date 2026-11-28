import { isProviderSendTurnSupportedImageMimeType } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { billPhotoPreviewId, isBillPdf } from "../../work/billPhotoForModel.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{
    name: string;
  }>`SELECT name FROM pragma_table_info('kin_bill_reads')`;
  if (columns.some(({ name }) => name === "preview_id")) return;
  yield* sql`ALTER TABLE kin_bill_reads ADD COLUMN preview_id TEXT`;
  // Keep the addresses of copies already on disk. The attachment server still checks the file.
  const photos = yield* sql<{
    orgId: string;
    sha256: string;
    id: string;
    name: string;
    mimeType: string;
  }>`
    SELECT org_id AS "orgId", sha256, attachment_id AS id, name, mime_type AS "mimeType"
    FROM kin_bill_reads WHERE file_type = 'image'`;
  for (const photo of photos) {
    if (isBillPdf(photo) || !isProviderSendTurnSupportedImageMimeType(photo.mimeType)) continue;
    const previewId = billPhotoPreviewId(photo.id);
    if (previewId !== null)
      yield* sql`UPDATE kin_bill_reads SET preview_id = ${previewId}
        WHERE org_id = ${photo.orgId} AND sha256 = ${photo.sha256}`;
  }
  yield* sql`CREATE INDEX idx_kin_bill_reads_preview ON kin_bill_reads (org_id, preview_id)
    WHERE preview_id IS NOT NULL`;
});
