// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { PENDING_UPLOAD_OWNER_SUFFIX } from "../attachmentStore.ts";
import type { PendingUploadOwner } from "./AttachmentUpload.ts";

/** What `sessionUploadOwner` records for a session with this id. */
export const testUploadOwner = (sessionId: string): PendingUploadOwner => `session:${sessionId}`;
export const TEST_UPLOAD_OWNER = testUploadOwner("test-uploader");

/** Records who uploaded a pending file a test wrote straight to disk. */
export function recordTestUploadOwner(
  attachmentsDir: string,
  attachmentId: string,
  owner: PendingUploadOwner = TEST_UPLOAD_OWNER,
) {
  NodeFS.mkdirSync(attachmentsDir, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(attachmentsDir, `${attachmentId}${PENDING_UPLOAD_OWNER_SUFFIX}`),
    owner,
  );
}

/** Directory entries other than owner records, for tests that count stored files. */
export const withoutOwnerRecords = (entries: ReadonlyArray<string>) =>
  entries.filter((entry) => !entry.endsWith(PENDING_UPLOAD_OWNER_SUFFIX));
