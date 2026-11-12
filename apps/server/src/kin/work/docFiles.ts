// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous page hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";
import { KinChatError, type KinDocEmbed, type KinOrgId } from "@t3tools/contracts";
import { kinDocBlocks, type KinDocBlock } from "@t3tools/shared/kinDocBlocks";
import { KIN_VISUAL_FILE_SCHEME, kinVisualFileReferences } from "@t3tools/shared/kinVisual";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { KinAttachmentStore } from "../chat/KinAttachmentStore.ts";
import { isOrgOwner } from "../lead/orgState.ts";
import { ChartInput, chartCardState } from "../widgets/chartCard.ts";
import { visualPage } from "../widgets/visualCard.ts";
import type { Writer } from "./KinRecords.ts";

/**
 * What a doc's markdown shows besides text: images it points at with `kin-file:<id>`, and its
 * `kin_chart` and `kin_visual` blocks. A file comes from the chat the writer is answering in or
 * from another doc of the org, and is then the doc's too, so its readers can load it.
 */

const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });
const decodeChart = Schema.decodeUnknownEffect(Schema.fromJsonString(ChartInput));
const hashOf = (html: string) => NodeCrypto.createHash("sha256").update(html).digest("hex");
const page = (block: KinDocBlock) => visualPage({ title: block.info, html: block.content });
const chart = (block: KinDocBlock) =>
  decodeChart(block.content).pipe(
    Effect.mapError(() =>
      invalid("A kin_chart block must hold the JSON kin_chart takes: chart, title, unit and data."),
    ),
    Effect.flatMap(chartCardState),
  );
const said = (what: string) => (error: KinChatError) =>
  invalid(`${what}: ${error.message} Nothing was written.`);

type FileRow = { readonly attachmentId: string; readonly mimeType: string | null };

/**
 * Whether the writer may read the org's docs, so take a file one shows. Docs are the owner's: the
 * owner, a lead of the org in an owner-only turn (its tools are admitted only there), or Kin.
 */
const readsDocs = Effect.fn("KinDocFiles.readsDocs")(function* (orgId: KinOrgId, writer: Writer) {
  const sql = yield* SqlClient.SqlClient;
  if (writer.actor._tag === "system") return true;
  if (writer.actor._tag === "person") return yield* isOrgOwner(orgId, writer.actor.personId);
  const agents = yield* sql`SELECT 1 FROM kin_agents
    WHERE org_id = ${orgId} AND agent_id = ${writer.actor.agentId} LIMIT 1`;
  return agents.length > 0;
});

/** Checks a body's blocks and files, and keeps them with the doc. Runs in the version's transaction. */
export const keepDocFiles = Effect.fn("KinDocFiles.keep")(function* (
  orgId: KinOrgId,
  recordId: string,
  writer: Writer,
  body: string,
) {
  const blocks = kinDocBlocks(body);
  const wanted = kinVisualFileReferences(body).map((id) => id.toLowerCase());
  if (blocks.length === 0 && wanted.length === 0) return;
  const pages: Array<{ readonly html: string; readonly sha256: string }> = [];
  for (const block of blocks) {
    if (block.kind === "chart")
      yield* chart(block).pipe(Effect.mapError(said("A kin_chart block")));
    else {
      const checked = yield* page(block).pipe(Effect.mapError(said("A kin_visual block")));
      pages.push({ html: checked.html, sha256: hashOf(checked.html) });
    }
  }
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  const kept = yield* sql<{ attachmentId: string; sha256: string | null }>`
    SELECT attachment_id AS "attachmentId", page_sha256 AS sha256 FROM kin_doc_files
    WHERE org_id = ${orgId} AND record_id = ${recordId} ORDER BY attachment_id`;
  const missing = wanted.filter((id) => !kept.some((row) => row.attachmentId === id));
  if (missing.length > 0) {
    const fromChat =
      writer.chatId === undefined
        ? []
        : yield* sql<FileRow>`SELECT a.attachment_id AS "attachmentId",
            (SELECT json_extract(j.value, '$.mimeType') FROM json_each(COALESCE(m.attachments_json, '[]')) j
              WHERE json_extract(j.value, '$.id') = a.attachment_id) AS "mimeType"
          FROM kin_message_attachments a
          JOIN kin_messages m ON m.org_id = a.org_id AND m.message_id = a.message_id
          WHERE a.org_id = ${orgId} AND a.chat_id = ${writer.chatId} AND m.status <> 'deleted'
            AND a.attachment_id IN ${sql.in(missing)} ORDER BY a.attachment_id`;
    // Only files a doc of this org shows, and only to a writer who may read that doc.
    const fromDocs = !(yield* readsDocs(orgId, writer))
      ? []
      : yield* sql<FileRow>`SELECT f.attachment_id AS "attachmentId", f.mime_type AS "mimeType"
          FROM kin_doc_files f JOIN kin_records r ON r.org_id = f.org_id
            AND r.record_id = f.record_id AND r.register_id = 'docs'
          WHERE f.org_id = ${orgId} AND f.attachment_id IN ${sql.in(missing)}
        UNION SELECT v.file_attachment_id, json_extract(v.file_json, '$.mimeType')
          FROM kin_doc_versions v JOIN kin_records r ON r.org_id = v.org_id
            AND r.record_id = v.record_id AND r.register_id = 'docs'
          WHERE v.org_id = ${orgId} AND v.file_attachment_id IN ${sql.in(missing)}
        ORDER BY 1`;
    for (const id of missing) {
      const found = [...fromChat, ...fromDocs].find((row) => row.attachmentId === id);
      if (found === undefined)
        return yield* invalid(
          `${KIN_VISUAL_FILE_SCHEME}${id} is not a file in this chat or in another doc. Use the id of an image sent in this chat or shown in another doc. Nothing was written.`,
        );
      yield* sql`INSERT INTO kin_doc_files (org_id, record_id, attachment_id, mime_type, page_sha256, created_at)
        VALUES (${orgId}, ${recordId}, ${id}, ${found.mimeType}, NULL, ${now})`;
    }
  }
  const fresh = pages.filter(
    (one, index) =>
      !kept.some((row) => row.sha256 === one.sha256) &&
      pages.findIndex((other) => other.sha256 === one.sha256) === index,
  );
  if (fresh.length === 0) return;
  const store = yield* Effect.serviceOption(KinAttachmentStore);
  if (Option.isNone(store))
    return yield* new KinChatError({
      reason: "unavailable",
      message: "Visuals can't be kept right now.",
    });
  for (const one of fresh) {
    // Written before the version commits; a write that then fails leaves an unread file.
    const attachmentId = yield* store.value.storePage(one.html);
    yield* sql`INSERT INTO kin_doc_files (org_id, record_id, attachment_id, mime_type, page_sha256, created_at)
      VALUES (${orgId}, ${recordId}, ${attachmentId}, 'text/html', ${one.sha256}, ${now})`;
  }
});

/** What each block of `body` draws, in order, from what `keepDocFiles` kept. */
export const docEmbeds = Effect.fn("KinDocFiles.embeds")(function* (
  orgId: KinOrgId,
  recordId: string,
  body: string,
) {
  const blocks = kinDocBlocks(body);
  if (blocks.length === 0) return [];
  const sql = yield* SqlClient.SqlClient;
  const pages = yield* sql<{ attachmentId: string; sha256: string }>`
    SELECT attachment_id AS "attachmentId", page_sha256 AS sha256 FROM kin_doc_files
    WHERE org_id = ${orgId} AND record_id = ${recordId} AND page_sha256 IS NOT NULL
    ORDER BY attachment_id`;
  return yield* Effect.forEach(blocks, (block) =>
    block.kind === "chart"
      ? chart(block).pipe(
          Effect.map((state): KinDocEmbed => ({ _tag: "chart", chart: state })),
          Effect.catch((error) =>
            Effect.succeed<KinDocEmbed>({ _tag: "broken", message: error.message }),
          ),
        )
      : page(block).pipe(
          Effect.map((checked): KinDocEmbed => {
            const sha256 = hashOf(checked.html);
            const found = pages.find((row) => row.sha256 === sha256);
            return found === undefined
              ? { _tag: "broken", message: "This visual's page is missing." }
              : {
                  _tag: "visual",
                  title: checked.title,
                  attachmentId: found.attachmentId,
                  height: checked.height,
                };
          }),
          Effect.catch((error) =>
            Effect.succeed<KinDocEmbed>({ _tag: "broken", message: error.message }),
          ),
        ),
  );
});

/** A doc's files, for a page of that doc: what it may show by `kin-file:` id. */
export const docPageSources = Effect.fn("KinDocFiles.pageSources")(function* (
  attachmentId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [owner] = yield* sql<{ orgId: KinOrgId; recordId: string }>`
    SELECT org_id AS "orgId", record_id AS "recordId" FROM kin_doc_files
    WHERE attachment_id = ${attachmentId} AND page_sha256 IS NOT NULL
    ORDER BY org_id, record_id LIMIT 1`;
  if (owner === undefined) return Option.none();
  const files = yield* sql<FileRow>`SELECT attachment_id AS "attachmentId", mime_type AS "mimeType"
    FROM kin_doc_files WHERE org_id = ${owner.orgId} AND record_id = ${owner.recordId}
      AND attachment_id <> ${attachmentId}
    ORDER BY attachment_id`;
  return Option.some({ orgId: owner.orgId, files });
});
